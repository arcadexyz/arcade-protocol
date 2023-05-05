// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./InterestCalculator.sol";
import "./FeeLookups.sol";
import "./libraries/LoanLibrary.sol";
import "./interfaces/IPromissoryNote.sol";
import "./interfaces/ILoanCore.sol";
import "./interfaces/IFeeController.sol";
import "./interfaces/IRepaymentController.sol";

import { RC_CannotDereference, RC_InvalidState, RC_OnlyLender, RC_NoPaymentDue, RC_BeforeStartDate, RC_ZeroAddress } from "./errors/Lending.sol";

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
        if (_loanCore == address(0)) revert RC_ZeroAddress();
        if (_feeController == address(0)) revert RC_ZeroAddress();

        loanCore = ILoanCore(_loanCore);
        lenderNote = loanCore.lenderNote();
        feeController = IFeeController(_feeController);
    }

    // ==================================== LIFECYCLE OPERATIONS ========================================

    /**
     * @notice Repay an active loan, referenced by borrower note ID (equivalent to loan ID). The interest for a loan
     *         is calculated, and the principal plus interest is withdrawn from the borrower.
     *         Control is passed to LoanCore to complete repayment.
     *
     * @param  loanId               The ID of the loan.
     */
    function repay(uint256 loanId) external override {
        LoanLibrary.LoanData memory data = loanCore.getLoan(loanId);
        if (data.state == LoanLibrary.LoanState.DUMMY_DO_NOT_USE) revert RC_CannotDereference(loanId);
        if (data.state != LoanLibrary.LoanState.Active) revert RC_InvalidState(data.state);

        LoanLibrary.LoanTerms memory terms = data.terms;

        // withdraw principal plus interest from borrower and send to loan core
        uint256 interest = getInterestAmount(terms.principal, terms.proratedInterestRate);
        if (terms.principal + interest == 0) revert RC_NoPaymentDue();

        // Account for fees to determine amount to lender
        uint256 interestFee = (interest * feeController.get(FL_07)) / BASIS_POINTS_DENOMINATOR;
        uint256 principalFee = (terms.principal * feeController.get(FL_08)) / BASIS_POINTS_DENOMINATOR;

        uint256 amountFromBorrower = terms.principal + interest;
        uint256 amountToLender = amountFromBorrower - interestFee - principalFee;

        // call repay function in loan core
        loanCore.repay(loanId, msg.sender, amountFromBorrower, amountToLender);
    }

    /**
     * @notice Claim collateral on an active loan, referenced by lender note ID (equivalent to loan ID).
     *         The loan must be past the due date. No funds are collected
     *         from the borrower.
     *
     * @param  loanId               The ID of the loan.
     */
    function claim(uint256 loanId) external override {
        // make sure that caller owns lender note
        // Implicitly checks if loan is active - if inactive, note will not exist
        address lender = lenderNote.ownerOf(loanId);
        if (lender != msg.sender) revert RC_OnlyLender(msg.sender);

        loanCore.claim(loanId);
    }
}
