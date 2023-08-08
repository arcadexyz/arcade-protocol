// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/INftfiRollover.sol";
import "../interfaces/IOriginationController.sol";
import "../interfaces/IRepaymentController.sol";
import "../interfaces/IFeeController.sol";

import "../external/interfaces/ILendingPool.sol";
import "../external/NFTFI/loans/direct/loanTypes/LoanData.sol";

import {
    R_UnknownCaller,
    R_InsufficientFunds,
    R_InsufficientAllowance,
    R_Paused
} from "./errors/NftfiRolloverErrors.sol";
import "hardhat/console.sol";
/**
 * @title FlashRolloverNftfiToV3
 * @author Non-Fungible Technologies, Inc.
 *
 * Based off Arcade.xyz's V1 lending FlashRollover.
 * Uses Balancer flash loan liquidity to repay a loan
 * on NftFi, and open a new loan on V3
 * (with lender's signature).
 */
contract FlashRolloverNftfiToV3 is INftfiRollover, ReentrancyGuard, ERC721Holder, Ownable {
    using SafeERC20 for IERC20;

    // Balancer vault contract
    /* solhint-disable var-name-mixedcase */
    IVault public immutable VAULT; // 0xBA12222222228d8Ba445958a75a0704d566BF2C8

    /// @notice nftfi contract references
    DirectLoanFixedOffer public constant directLoanFixedOffer = DirectLoanFixedOffer(0xE52Cec0E90115AbeB3304BaA36bc2655731f7934);
    IDirectLoanCoordinator public constant loanCoordinator = IDirectLoanCoordinator(0x0C90C8B4aa8549656851964d5fB787F0e4F54082);

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

    function rolloverNftfiLoan(
        uint32 loanId, // old loanId
        LoanLibrary.LoanTerms calldata newLoanTerms,
        address lender,
        uint160 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external {
        LoanData.LoanTerms memory loanTermsNftfi = _getLoanTermsNftfi(loanId);

        {
            (address borrower) =_validateRollover(
                loanTermsNftfi,
                newLoanTerms,
                loanId
            );
        }

        {
            IERC20[] memory assets = new IERC20[](1);
            assets[0] = IERC20(loanTermsNftfi.loanERC20Denomination);

            uint256[] memory amounts = new uint256[](1);
            amounts[0] = loanTermsNftfi.maximumRepaymentAmount;

            uint256[] memory modes = new uint256[](1);
            modes[0] = 0;

            bytes memory params = abi.encode(
                OperationDataWithItems({
                    loanId: loanId,
                    borrower: 0x2B6C7d09C6c28a027b38A2721C3f4bD3C61Af964,
                    newLoanTerms: newLoanTerms,
                    lender: lender,
                    nonce: nonce,
                    v: v,
                    r: r,
                    s: s,
                    itemPredicates: itemPredicates
                })
            );

            // Flash loan based on principal + interest
            VAULT.flashLoan(this, assets, amounts, params);
        }
    }

    /**
    * @notice TODO: add natspce
    */
    function _getLoanTermsNftfi(uint32 loanId) internal returns(LoanData.LoanTerms memory){
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
    * @notice TODO: add natspce
    */
    function receiveFlashLoan(
        IERC20[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata params
    ) external override nonReentrant {
        if (msg.sender != address(VAULT)) revert R_UnknownCaller(msg.sender, address(VAULT));

        OperationDataWithItems memory opData = abi.decode(params, (OperationDataWithItems));
        _executeOperation(assets, amounts, feeAmounts, opData);
    }

    /**
    * @notice TODO: add natspce
    */
    function _executeOperation(
        IERC20[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        OperationDataWithItems memory opData
    ) internal returns (bool) {
        // Get smartNFTId to look up lender promissoryNote and borrower obligationReceipt
        IDirectLoanCoordinator.Loan memory loanData = IDirectLoanCoordinator(loanCoordinator).getLoanData(uint32(opData.loanId));
        uint64 smartNftId = loanData.smartNftId;

        address borrower = IERC721(IDirectLoanCoordinator(loanCoordinator).obligationReceiptToken()).ownerOf(smartNftId);
        address lender = IERC721(IDirectLoanCoordinator(loanCoordinator).promissoryNoteToken()).ownerOf(smartNftId); // old lender


        // Do accounting to figure out amount each party needs to receive
        (uint256 flashAmountDue, uint256 needFromBorrower, uint256 leftoverPrincipal) = _ensureFunds(
            amounts[0],
            premiums[0],
            uint256(
                IFeeController(feeController).getLendingFee(
                    // FL_01 - borrower origination fee
                    keccak256("BORROWER_ORIGINATION_FEE")
                )
            ),
            opData.newLoanTerms.principal
        );

        IERC20 asset = IERC20(assets[0]);

        if (needFromBorrower > 0) {
            require(asset.balanceOf(borrower) < needFromBorrower, "borrower cannot pay");
            require(asset.allowance(borrower, address(this)) < needFromBorrower, "not enough allowance");
        }


        {
            LoanData.LoanTerms memory loanTermsNftfi = _getLoanTermsNftfi(uint32(opData.loanId));

            _repayLoan(loanTermsNftfi, borrower, uint32(opData.loanId));

            uint256 newLoanId = _initializeNewLoanWithItems(
                borrower,
                opData.lender,
                opData
            );

            emit RolloverNftfi(
                lender,
                borrower,
                uint32(opData.loanId), // old loanId, i.e. NftFi loanId
                newLoanId
            );
        }

        if (leftoverPrincipal > 0) {
            asset.safeTransfer(borrower, leftoverPrincipal);
        } else if (needFromBorrower > 0) {
            asset.safeTransferFrom(borrower, address(this), needFromBorrower);
        }

        // Make flash loan repayment
        // Balancer requires a transfer back to the vault
        asset.transfer(address(VAULT), flashAmountDue);

        return true;
    }

    /**
    // * @notice TODO: add natspce
    // */
    function _ensureFunds(
        uint256 amount,
        uint256 premium,
        uint256 originationFee,
        uint256 newPrincipal
    )
        internal
        view
        returns (
            uint256 flashAmountDue,
            uint256 needFromBorrower,
            uint256 leftoverPrincipal
        )
    {
        // Make sure new loan, minus pawn fees, can be repaid
        flashAmountDue = amount + premium;
        uint256 willReceive = newPrincipal - ((newPrincipal * originationFee) / 1e4);

        if (flashAmountDue > willReceive) {
            // Not enough - have borrower pay the difference
            needFromBorrower = flashAmountDue - willReceive;
        } else if (willReceive > flashAmountDue) {
            // Too much - will send extra to borrower
            leftoverPrincipal = willReceive - flashAmountDue;
        }

        // Either leftoverPrincipal or needFromBorrower should be 0
        require(leftoverPrincipal == 0 || needFromBorrower == 0, "funds conflict");
    }

    /**
    * @notice TODO: add natspce
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

        IERC721(IDirectLoanCoordinator(loanCoordinator).obligationReceiptToken())
            .safeTransferFrom(borrower, address(this), smartNftId);

        // Approve repayment
        IERC20(loanTermsNftfi.loanERC20Denomination).approve(
            address(directLoanFixedOffer),
            loanTermsNftfi.maximumRepaymentAmount
        );

        // Repay loan
        DirectLoanFixedOffer(address(directLoanFixedOffer)).payBackLoan(loanId);

        // contract now has NFT but has lost funds
        require(
            IERC721(loanTermsNftfi.nftCollateralContract).ownerOf(loanTermsNftfi.nftCollateralId) == address(this),
            "collateral ownership"
        );
    }

    /**
    * @notice TODO: add natspce
    */
    function _initializeNewLoanWithItems(
        address borrower,
        address lender,
        OperationDataWithItems memory opData
    ) internal returns (uint256) {
        // approve originationController
        IERC721(opData.newLoanTerms.collateralAddress).approve(address(loanCore), opData.newLoanTerms.collateralId);

        // start new loan
        // stand in for borrower to meet OriginationController's requirements
        uint256 newLoanId = IOriginationController(originationController).initializeLoanWithItems(
            opData.newLoanTerms,
            address(this),
            lender,
            IOriginationController.Signature({
                v: opData.v,
                r: opData.r,
                s: opData.s,
                extraData: "0x"
            }),
            opData.nonce,
            opData.itemPredicates
        );
console.log("SOL 343 END OF INITIALIZE NEW LOAN ====================", address(borrowerNote));
        IERC721(address(borrowerNote)).safeTransferFrom(address(this), borrower, newLoanId);
console.log("SOL 343 END OF INITIALIZE NEW LOAN ====================", newLoanId);
        return newLoanId;
    }

    /**
    * @notice TODO: add natspce
    */
    function _validateRollover(
        LoanData.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        uint32 loanId
    ) internal view returns (address borrower) {

        IDirectLoanCoordinator.Loan memory loanCoordinatorData = IDirectLoanCoordinator(loanCoordinator).getLoanData(loanId);

        uint256 smartNftId = loanCoordinatorData.smartNftId;
        address borrower = IERC721(IDirectLoanCoordinator(loanCoordinator).obligationReceiptToken())
            .ownerOf(smartNftId);

        require(newLoanTerms.payableCurrency == sourceLoanTerms.loanERC20Denomination, "currency mismatch");

        // TODO: compare that new loaterms collateral address and ID matches nftfi's
        // //require(
        //     newLoanTerms.collateralAddress == address(vaultFactory), "must use vault"
        // );
        return borrower;
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

    receive() external payable {}
}
