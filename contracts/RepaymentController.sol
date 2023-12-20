// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/IRepaymentController.sol";
import "./interfaces/IPromissoryNote.sol";
import "./interfaces/ILoanCore.sol";
import "./interfaces/IFeeController.sol";

import "./libraries/InterestCalculator.sol";
import "./libraries/FeeLookups.sol";
import "./libraries/LoanLibrary.sol";

import {
    RC_ZeroAddress,
    RC_CannotDereference,
    RC_InvalidState,
    RC_OnlyLender,
    RC_InvalidRepayment
} from "./errors/Lending.sol";

/**
 * @title RepaymentController
 * @author Non-Fungible Technologies, Inc.
 *
 * The Repayment Controller is the entry point for all loan lifecycle
 * operations in the Arcade.xyz lending protocol once a loan has begun.
 * This contract allows a caller to calculate an amount due on a loan,
 * repay an open loan, and claim collateral on a defaulted loan. It
 * is this contract's responsibility to verify loan conditions before
 * calling LoanCore.
 */
contract RepaymentController is IRepaymentController, InterestCalculator, FeeLookups {
    using SafeERC20 for IERC20;

    // ============================================ STATE ===============================================

    ILoanCore private immutable loanCore;
    IPromissoryNote private immutable lenderNote;
    IFeeController private immutable feeController;

    uint256 public constant MAX_INT = 2**256 - 1;

    // ========================================= CONSTRUCTOR ============================================

    /**
     * @notice Creates a new repayment controller contract.
     *
     * @dev For this controller to work, it needs to be granted the REPAYER_ROLE
     *      in loan core after deployment.
     *
     * @param _loanCore                     The address of the loan core logic of the protocol.
     * @param _feeController                The address of the fee logic of the protocol.
     */
    constructor(address _loanCore, address _feeController) {
        if (_loanCore == address(0)) revert RC_ZeroAddress("loanCore");
        if (_feeController == address(0)) revert RC_ZeroAddress("feeController");

        loanCore = ILoanCore(_loanCore);
        lenderNote = loanCore.lenderNote();
        feeController = IFeeController(_feeController);
    }

    // ==================================== LIFECYCLE OPERATIONS ========================================

    /**
     * @notice Send a repayment for an active loan, referenced by BorrowerNote ID (equivalent to loan ID).
     *         The interest for the loan is calculated, and the repayment amount plus interest is withdrawn
     *         from the caller. The repayment amount at a minimum must cover any interest accrued. There are
     *         no partial repayments to interest, only principal. Anyone can repay a loan. After the
     *         repayment amounts are calculated, control is passed to LoanCore to complete repayment and
     *         update LoanData accounting.
     *
     * @param  loanId               The ID of the loan.
     * @param  amount               The amount to repay.
     */
    function repay(uint256 loanId, uint256 amount) external override {
        // no zero amount check, minimum principal could be 0 for this payable currency

        (
            uint256 amountToLender,
            uint256 interestAmount,
            uint256 paymentToPrincipal
        ) = _prepareRepay(loanId, amount);

        // call repay function in LoanCore - msg.sender will pay the amountFromBorrower
        loanCore.repay(loanId, msg.sender, amountToLender, interestAmount, paymentToPrincipal);
    }

    /**
     * @notice Completely repay an active loan, referenced by BorrowerNote ID (equivalent to loan ID).
     *         The interest for the loan is calculated, and the remaining balance plus interest is withdrawn
     *         from the caller. Anyone can repay a loan. After the repayment amounts are calculated, control
     *         is passed to LoanCore to complete repayment and update LoanData accounting.
     *
     * @param  loanId               The ID of the loan.
     */
    function repayFull(uint256 loanId) external override {
        (
            uint256 amountToLender,
            uint256 interestAmount,
            uint256 paymentToPrincipal
        ) = _prepareRepay(loanId, type(uint256).max);

        // call repay function in LoanCore - msg.sender will pay the amountFromBorrower
        loanCore.repay(loanId, msg.sender, amountToLender, interestAmount, paymentToPrincipal);
    }

    /**
     * @notice Send a repayment for an active loan, referenced by BorrowerNote ID (equivalent to loan ID).
     *         The interest for a loan is calculated, and the repayment amount plus interest is withdrawn
     *         from the caller. The repayment amount at a minimum must cover any interest accrued. There are
     *         no partial repayments to interest, only principal. Anyone can repay a loan.
     *
     * @dev Using forceRepay will not send funds to the lender: instead, those funds will be made available
     *      for withdrawal in LoanCore. Can be used in cases where a borrower has funds to repay but the
     *      lender is not able to receive those tokens (e.g. token blacklist).
     *
     * @param  loanId               The ID of the loan.
     * @param  amount               The amount to repay.
     */
    function forceRepay(uint256 loanId, uint256 amount) external override {
        // no zero amount check, minimum principal could be 0 for this payable currency

        (
            uint256 amountToLender,
            uint256 interestAmount,
            uint256 paymentToPrincipal
        ) = _prepareRepay(loanId, amount);

        // call repay function in LoanCore - msg.sender will pay the amountFromBorrower
        loanCore.forceRepay(loanId, msg.sender, amountToLender, interestAmount, paymentToPrincipal);
    }

    /**
     * @notice Claim collateral on an active loan, referenced by lender note ID (equivalent to loan ID).
     *         The loan must be past the due date. No funds are collected
     *         from the borrower.
     *
     * @param  loanId               The ID of the loan.
     */
    function claim(uint256 loanId) external override {
        LoanLibrary.LoanData memory data = loanCore.getLoan(loanId);
        if (data.state == LoanLibrary.LoanState.DUMMY_DO_NOT_USE) revert RC_CannotDereference(loanId);

        // make sure that caller owns lender note
        // Implicitly checks if loan is active - if inactive, note will not exist
        address lender = lenderNote.ownerOf(loanId);
        if (lender != msg.sender) revert RC_OnlyLender(lender, msg.sender);

        LoanLibrary.LoanTerms memory terms = data.terms;

        uint256 interest = getProratedInterestAmount(
            data.balance,
            terms.interestRate,
            terms.durationSecs,
            uint64(data.startDate),
            uint64(data.lastAccrualTimestamp),
            block.timestamp
        );
        uint256 totalOwed = terms.principal + interest;

        uint256 claimFee = (totalOwed * data.feeSnapshot.lenderDefaultFee) / BASIS_POINTS_DENOMINATOR;

        loanCore.claim(loanId, claimFee);
    }

    /**
     * @notice Redeem a lender note for a completed return in return for funds repaid in an earlier
     *         transaction via forceRepay. The lender note must be owned by the caller.
     *
     * @param loanId                    The ID of the lender note to redeem.
     */
    function redeemNote(uint256 loanId, address to) external override {
        if (to == address(0)) revert RC_ZeroAddress("to");

        (, uint256 amountOwed) = loanCore.getNoteReceipt(loanId);

        address lender = lenderNote.ownerOf(loanId);
        if (lender != msg.sender) revert RC_OnlyLender(lender, msg.sender);

        uint256 redeemFee = (amountOwed * feeController.getLendingFee(FL_08)) / BASIS_POINTS_DENOMINATOR;

        loanCore.redeemNote(loanId, redeemFee, to);
    }

    // =========================================== HELPERS ==============================================

    /**
     * @dev Shared logic to perform validation and calculations for repay and forceRepay.
     *
     * @param loanId               The ID of the loan.
     * @param amount               The amount to repay.
     *
     * @return amountToLender       The amount owed to the lender.
     * @return interestAmount       The amount of interest due.
     * @return paymentToPrincipal   The portion of the repayment amount that goes to principal.
     */
    function _prepareRepay(uint256 loanId, uint256 amount)
        internal
        view
        returns (
            uint256 amountToLender,
            uint256 interestAmount,
            uint256 paymentToPrincipal
        )
    {
        // get loan data
        LoanLibrary.LoanData memory data = loanCore.getLoan(loanId);

        // loan state checks
        if (data.state == LoanLibrary.LoanState.DUMMY_DO_NOT_USE) revert RC_CannotDereference(loanId);
        if (data.state != LoanLibrary.LoanState.Active) revert RC_InvalidState(data.state);

        // get interest amount due
        interestAmount = getProratedInterestAmount(
            data.balance,
            data.terms.interestRate,
            data.terms.durationSecs,
            uint64(data.startDate),
            uint64(data.lastAccrualTimestamp),
            block.timestamp
        );

        if(amount == MAX_INT) {
            // shortcut for full repayment
            paymentToPrincipal = data.balance;
        } else {
            // make sure that repayment amount is greater than interest due
            if (amount < interestAmount) revert RC_InvalidRepayment(amount, interestAmount);

            // calculate the amount of the repayment that goes to the principal
            paymentToPrincipal = amount - interestAmount;

            // check if payment to principal is greater than the loan balance
            if (paymentToPrincipal > data.balance) {
                // if so, set payment to principal to the loan balance
                paymentToPrincipal = data.balance;
            }
        }

        // calculate fees on interest and principal
        uint256 interestFee = (interestAmount * data.feeSnapshot.lenderInterestFee) / BASIS_POINTS_DENOMINATOR;
        uint256 principalFee = (paymentToPrincipal * data.feeSnapshot.lenderPrincipalFee) / BASIS_POINTS_DENOMINATOR;

        // the amount to collect from the caller
        uint256 amountFromBorrower = paymentToPrincipal + interestAmount;
        // the amount to send to the lender
        amountToLender = amountFromBorrower - interestFee - principalFee;
    }
}
