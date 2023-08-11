// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../../interfaces/INftfiRolloverBase.sol";

import {
    NR_FundsConflict,
    NR_NotCollateralOwner,
    NR_CurrencyMismatch,
    NR_CollateralIdMismatch,
    NR_CollateralMismatch,
    NR_CallerNotBorrower
} from "../errors/NftfiRolloverErrors.sol";

/**
 * @title NftfiRolloverBase
 * @author Non-Fungible Technologies, Inc.
 *
 * This contract holds the common logic for the NftfiToV3Rollover and NftfiToV3RolloverWithItems contracts.
 */
abstract contract NftfiRolloverBase is INftfiRolloverBase, ReentrancyGuard, ERC721Holder, Ownable {
    using SafeERC20 for IERC20;

    // Balancer vault contract
    /* solhint-disable var-name-mixedcase */
    IVault public immutable VAULT; // 0xBA12222222228d8Ba445958a75a0704d566BF2C8

    /// @notice nftfi contract references
    DirectLoanFixedOffer public constant directLoanFixedOffer =
        DirectLoanFixedOffer(0xE52Cec0E90115AbeB3304BaA36bc2655731f7934);
    IDirectLoanCoordinator public constant loanCoordinator =
        IDirectLoanCoordinator(0x0C90C8B4aa8549656851964d5fB787F0e4F54082);

    /// @notice V3 lending protocol contract references
    IFeeController public immutable feeController;
    IOriginationController public immutable originationController;
    ILoanCore public immutable loanCore;
    IERC721 public immutable borrowerNote;

    /// @notice state variable for pausing the contract
    bool public paused = false;

    constructor(IVault _vault, OperationContracts memory _opContracts) {
        // Set Balancer vault address
        VAULT = _vault;

        // Set lending protocol contract references
        feeController = IFeeController(_opContracts.feeController);
        originationController = IOriginationController(_opContracts.originationController);
        loanCore = ILoanCore(_opContracts.loanCore);
        borrowerNote = IERC721(_opContracts.borrowerNote);
    }

        /**
     * @notice This helper function to calculate the net amounts required to repay the flash loan.
     *         This function will return the total amount due back to the lending pool. The amount
     *         that needs to be paid by the borrower, in the case that the new loan does not cover
     *         the flashAmountDue. Lastly, the amount that will be sent back to the borrower, in
     *         the case that the new loan covers more than the flashAmountDue.
     *
     * @param amount                  The amount that was borrowed in Flash Loan.
     * @param premium                 The fees that are due back to the lending pool.
     * @param originationFee          The origination fee for the new loan.
     * @param newPrincipal            The principal of the new loan.
     *
     * @return flashAmountDue         The total amount due back to the lending pool.
     * @return needFromBorrower       The amount borrower owes if new loan cannot repay flash loan.
     * @return leftoverPrincipal      The amount to send to borrower if new loan amount is more than
     *                                amount required to repay flash loan.
     */
    function _ensureFunds(
        uint256 amount,
        uint256 premium,
        uint256 originationFee,
        uint256 newPrincipal
    ) internal view returns (uint256 flashAmountDue, uint256 needFromBorrower, uint256 leftoverPrincipal) {
        // total amount due to flash loan contract
        flashAmountDue = amount + premium;
        // amount that will be received when starting the new loan
        uint256 willReceive = newPrincipal - ((newPrincipal * originationFee) / 1e4);

        if (flashAmountDue > willReceive) {
            // Not enough - have borrower pay the difference
            needFromBorrower = flashAmountDue - willReceive;
        } else if (willReceive > flashAmountDue) {
            // Too much - will send extra to borrower
            leftoverPrincipal = willReceive - flashAmountDue;
        }

        // Either leftoverPrincipal or needFromBorrower should be 0
        if (leftoverPrincipal != 0 && needFromBorrower != 0) {
            revert NR_FundsConflict(leftoverPrincipal, needFromBorrower);
        }
    }

    /**
     * @notice Helper function to repay the loan. Takes the NFTFI obligationReceiptToken from the borrower, and
     *         approves the directLoanFixedOffer contract to spend the payable currency received from flash loan.
     *         Repays the loan, and ensures this contract holds the collateral after the loan is repaid.
     *
     * @param loanTermsNftfi           The loan terms for the loan to be repaid.
     * @param borrower                 The address of the borrower for the loan to be repaid.
     * @param loanId                   The id of the loan to be repaid.
     */
    function _repayLoan(
        LoanData.LoanTerms memory loanTermsNftfi,
        address borrower,
        uint32 loanId
    ) internal {
        // Take obligationReceiptToken from borrower
        // Must be approved for withdrawal
        IDirectLoanCoordinator.Loan memory loanData = IDirectLoanCoordinator(loanCoordinator).getLoanData(loanId);
        uint64 smartNftId = loanData.smartNftId;

        IERC721(IDirectLoanCoordinator(loanCoordinator).obligationReceiptToken()).safeTransferFrom(
            borrower,
            address(this),
            smartNftId
        );

        // Approve repayment
        IERC20(loanTermsNftfi.loanERC20Denomination).approve(
            address(directLoanFixedOffer),
            loanTermsNftfi.maximumRepaymentAmount
        );

        // Repay loan
        DirectLoanFixedOffer(address(directLoanFixedOffer)).payBackLoan(loanId);

        address collateralOwner = IERC721(loanTermsNftfi.nftCollateralContract).ownerOf(loanTermsNftfi.nftCollateralId);
        if (collateralOwner != address(this)) revert NR_NotCollateralOwner(collateralOwner);
    }

    /**
     * @notice Validates that the rollover is valid. The borrower from the NFTFI loan must be the caller.
     *         The new loan must have the same currency as the NFTFI loan. The new loan must use the same
     *         collateral as the NFTFI loan. If any of these conditionals are not met, the transaction
     *         will revert.
     *
     * @param sourceLoanTerms           The terms of the NFTFI loan.
     * @param newLoanTerms              The terms of the V3 loan.
     * @param loanId                    The ID of the NFTFI loan.
     */
    function _validateRollover(
        LoanData.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        uint32 loanId
    ) internal view {
        IDirectLoanCoordinator.Loan memory loanCoordinatorData = IDirectLoanCoordinator(loanCoordinator).getLoanData(
            loanId
        );

        uint256 smartNftId = loanCoordinatorData.smartNftId;
        address borrower = IERC721(IDirectLoanCoordinator(loanCoordinator).obligationReceiptToken()).ownerOf(
            smartNftId
        );

        if (borrower != msg.sender) revert NR_CallerNotBorrower(msg.sender, borrower);

        if (sourceLoanTerms.loanERC20Denomination != newLoanTerms.payableCurrency) {
            revert NR_CurrencyMismatch(sourceLoanTerms.loanERC20Denomination, newLoanTerms.payableCurrency);
        }

        if (sourceLoanTerms.nftCollateralContract != newLoanTerms.collateralAddress) {
            revert NR_CollateralMismatch(sourceLoanTerms.nftCollateralContract, newLoanTerms.collateralAddress);
        }

        if (sourceLoanTerms.nftCollateralId != newLoanTerms.collateralId) {
            revert NR_CollateralIdMismatch(sourceLoanTerms.nftCollateralId, newLoanTerms.collateralId);
        }
    }

    /**
     * @notice Helper function to get the loan terms for the NFTFI loan.
     *
     * @param loanId                   The id of the loan for which the terms are needed.
     *
     * @return loanTermsNftfi          The terms associates with the NFTFI loan id.
     */
    function _getLoanTermsNftfi(uint32 loanId) internal returns (LoanData.LoanTerms memory) {
        (
            uint256 loanPrincipalAmount,
            uint256 maximumRepaymentAmount,
            uint256 nftCollateralId,
            address loanERC20Denomination,
            uint32 loanDuration,
            uint16 loanInterestRateForDurationInBasisPoints,
            uint16 loanAdminFeeInBasisPoints,
            address nftCollateralWrapper,
            uint64 loanStartTime,
            address nftCollateralContract,
            address borrower
        ) = DirectLoanFixedOffer(address(directLoanFixedOffer)).loanIdToLoan(loanId);

        LoanData.LoanTerms memory loanTermsNftfi = LoanData.LoanTerms(
            loanPrincipalAmount,
            maximumRepaymentAmount,
            nftCollateralId,
            loanERC20Denomination,
            loanDuration,
            loanInterestRateForDurationInBasisPoints,
            loanAdminFeeInBasisPoints,
            nftCollateralWrapper,
            loanStartTime,
            nftCollateralContract,
            borrower
        );

        return loanTermsNftfi;
    }

    /**
     * @notice Function to be used by the contract owner to withdraw any ERC20 tokens that
     *         are sent to the contract and get stuck.
     */
    function flushToken(IERC20 token, address to) external override {
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "no balance");

        token.transfer(to, balance);
    }

    /**
     * @notice Function to be used by the contract owner to pause the contract.
     *
     * @dev This function is only to be used if a vulnerability is found or the contract
     *      is no longer being used.
     */
    function togglePause() external override onlyOwner {
        paused = !paused;
    }
}