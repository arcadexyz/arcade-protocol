// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../external/lp-1/loans/direct/loanTypes/DirectLoanFixedOffer.sol";

import "../interfaces/IMigrationBase.sol";

import {
    MR_FundsConflict,
    MR_NotCollateralOwner,
    MR_CurrencyMismatch,
    MR_CollateralIdMismatch,
    MR_CollateralMismatch,
    MR_CallerNotBorrower
} from "../errors/MigrationErrors.sol";

import {
    R_StateAlreadySet,
    R_ZeroAddress,
    R_BorrowerNotReset
} from "../errors/RolloverErrors.sol";

/**
 * @title LP1MigrationBase
 * @author Non-Fungible Technologies, Inc.
 *
 * This contract holds the common logic for the LP1Migration and LP1MigrationWIthItems contracts.
 */
abstract contract LP1MigrationBase is IMigrationBase, ReentrancyGuard, ERC721Holder, Ownable {
    using SafeERC20 for IERC20;

    event Migration(
        address indexed lender,
        address indexed borrower,
        uint256 oldLoanId,
        uint256 newLoanId
    );

    struct OperationContracts {
        IFeeController feeControllerV3;
        IOriginationControllerV3 originationControllerV3;
        ILoanCore loanCoreV3;
        IERC721 borrowerNoteV3;
    }

    struct LP1Deployment {
        address directLoanFixedOffer;
        address loanCoordinator;
    }

    enum LoanType {
        V2,
        V2_1,
        V2_3,
        COLLECTION_V2,
        COLLECTION_V2_3
    }

    struct Signature {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct OperationData {
        uint256 loanId;
        address borrower;
        LoanLibrary.LoanTerms newLoanTerms;
        address lender;
        uint160 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
        LoanType loanType;
    }

    // Balancer vault contract
    /* solhint-disable var-name-mixedcase */
    IVault public immutable VAULT; // 0xBA12222222228d8Ba445958a75a0704d566BF2C8

    /// @notice V3 lending protocol contract references
    LP1Deployment[5] public deployments;

    IFeeController public immutable feeController;
    IOriginationControllerV3 public immutable originationController;
    ILoanCore public immutable loanCore;
    IERC721 public immutable borrowerNote;

    /// @notice State variable used for checking the inheriting contract initiated the flash
    ///         loan. When a rollover function is called the borrowers address is cached here
    ///         and checked against the opData in the flash loan callback.
    address public borrower;

    /// @notice state variable for pausing the contract
    bool public paused;

    constructor(IVault _vault, OperationContracts memory _opContracts, LP1Deployment[] memory _deployments) {
        // input sanitization
        if (address(_vault) == address(0)) revert R_ZeroAddress("vault");
        if (address(_opContracts.feeControllerV3) == address(0)) revert R_ZeroAddress("feeControllerV3");
        if (address(_opContracts.originationControllerV3) == address(0)) revert R_ZeroAddress("originationControllerV3");
        if (address(_opContracts.loanCoreV3) == address(0)) revert R_ZeroAddress("loanCoreV3");
        if (address(_opContracts.borrowerNoteV3) == address(0)) revert R_ZeroAddress("borrowerNoteV3");

        // Set Balancer vault address
        VAULT = _vault;

        // Set lending protocol contract references
        feeController = IFeeController(_opContracts.feeControllerV3);
        originationController = IOriginationControllerV3(_opContracts.originationControllerV3);
        loanCore = ILoanCore(_opContracts.loanCoreV3);
        borrowerNote = IERC721(_opContracts.borrowerNoteV3);

        // Set LP1 deployment references
        require(_deployments.length == 5, "Invalid versions");

        deployments[0] = _deployments[0];
        deployments[1] = _deployments[1];
        deployments[2] = _deployments[2];
        deployments[3] = _deployments[3];
        deployments[4] = _deployments[4];
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
    ) internal pure returns (uint256 flashAmountDue, uint256 needFromBorrower, uint256 leftoverPrincipal) {
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
            revert MR_FundsConflict(leftoverPrincipal, needFromBorrower);
        }
    }

    /**
     * @notice Helper function to repay the loan. Takes the obligationReceiptToken from the borrower, and
     *         approves the directLoanFixedOffer contract to spend the payable currency received from flash loan.
     *         Repays the loan, and ensures this contract holds the collateral after the loan is repaid.
     *
     * @param loanTerms                The loan terms for the loan to be repaid.
     * @param borrower_                The address of the borrower for the loan to be repaid (trailing underscore
                                        to differentiate from the borrower state variable)
     * @param loanId                   The id of the loan to be repaid.
     */
    function _repayLoan(
        LoanData.LoanTerms memory loanTerms,
        address borrower_,
        uint32 loanId,
        LoanType loanType
    ) internal {
        LP1Deployment memory addresses = deployments[uint256(loanType)];
        IDirectLoanCoordinator loanCoordinator = IDirectLoanCoordinator(addresses.loanCoordinator);
        DirectLoanFixedOffer directLoanFixedOffer = DirectLoanFixedOffer(addresses.directLoanFixedOffer);

        // Take obligationReceiptToken from borrower
        // Must be approved for withdrawal
        IDirectLoanCoordinator.Loan memory loanData = loanCoordinator.getLoanData(loanId);
        uint64 smartNftId = loanData.smartNftId;

        IERC721(loanCoordinator.obligationReceiptToken()).safeTransferFrom(
            borrower_,
            address(this),
            smartNftId
        );

        // Approve repayment
        IERC20(loanTerms.loanERC20Denomination).approve(
            address(directLoanFixedOffer),
            loanTerms.maximumRepaymentAmount
        );

        // Repay loan
        directLoanFixedOffer.payBackLoan(loanId);

        address collateralOwner = IERC721(loanTerms.nftCollateralContract).ownerOf(loanTerms.nftCollateralId);
        if (collateralOwner != address(this)) revert MR_NotCollateralOwner(collateralOwner);
    }

    /**
     * @notice Validates that the migration is valid. The borrower from the loan must be the caller.
     *         The new loan must have the same currency as the old loan. The new loan must use the same
     *         collateral as the old loan. If any of these conditionals are not met, the transaction
     *         will revert.
     *
     * @param sourceLoanTerms           The terms of the old loan.
     * @param newLoanTerms              The terms of the V3 loan.
     * @param loanId                    The ID of the old loan.
     */
    function _validateMigration(
        LoanData.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        uint256 loanId,
        LoanType loanType
    ) internal view returns (address _borrower) {
        LP1Deployment memory addresses = deployments[uint256(loanType)];
        IDirectLoanCoordinator loanCoordinator = IDirectLoanCoordinator(addresses.loanCoordinator);

        IDirectLoanCoordinator.Loan memory loanCoordinatorData = loanCoordinator.getLoanData(
            uint32(loanId)
        );

        uint256 smartNftId = loanCoordinatorData.smartNftId;
        _borrower = IERC721(loanCoordinator.obligationReceiptToken()).ownerOf(
            smartNftId
        );

        if (_borrower != msg.sender) revert MR_CallerNotBorrower(msg.sender, _borrower);

        if (sourceLoanTerms.loanERC20Denomination != newLoanTerms.payableCurrency) {
            revert MR_CurrencyMismatch(sourceLoanTerms.loanERC20Denomination, newLoanTerms.payableCurrency);
        }

        if (sourceLoanTerms.nftCollateralContract != newLoanTerms.collateralAddress) {
            revert MR_CollateralMismatch(sourceLoanTerms.nftCollateralContract, newLoanTerms.collateralAddress);
        }

        if (sourceLoanTerms.nftCollateralId != newLoanTerms.collateralId) {
            revert MR_CollateralIdMismatch(sourceLoanTerms.nftCollateralId, newLoanTerms.collateralId);
        }
    }

    /**
     * @notice Helper function to get the loan terms for the loan.
     *
     * @param loanId                   The id of the loan for which the terms are needed.
     *
     * @return loanTerms               The terms associated with the loan id.
     */
    function _getLoanTerms(uint256 loanId, LoanType loanType) internal view returns (LoanData.LoanTerms memory) {
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
            address _borrower
        ) = DirectLoanFixedOffer(deployments[uint256(loanType)].directLoanFixedOffer).loanIdToLoan(uint32(loanId));

        return LoanData.LoanTerms(
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
            _borrower
        );
    }

    /**
     * @notice Function to be used by the contract owner to withdraw any ERC20 tokens that
     *         are sent to the contract and get stuck.
     */
    function flushToken(IERC20 token, address to) external override {
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "no balance");

        token.safeTransfer(to, balance);
    }

    /**
     * @notice Function to be used by the contract owner to pause the contract.
     *
     * @dev This function is only to be used if a vulnerability is found or the contract
     *      is no longer being used.
     *
     * @param _pause              The state to set the contract to.
     */
    function pause(bool _pause) external override onlyOwner {
        if (paused == _pause) revert R_StateAlreadySet();

        paused = _pause;

        emit PausedStateChanged(_pause);
    }

    /**
     * @notice This function ensures that at the start of every flash loan sequence, the borrower
     *         state is reset to address(0). The rollover functions that inherit this modifier set
     *         the borrower state while executing the rollover operations. At the end of the rollover
     *         the borrower state is reset to address(0).
     */
    modifier whenBorrowerReset() {
        if (borrower != address(0)) revert R_BorrowerNotReset(borrower);

        _;

        borrower = address(0);
    }
}