// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../libraries/OriginationLibrary.sol";
import "../libraries/InterestCalculator.sol";
import "../libraries/LoanLibrary.sol";
import "../libraries/Constants.sol";

import "../interfaces/IOriginationControllerRefinance.sol";
import "../interfaces/IOriginationSharedStorage.sol";
import "../interfaces/ILoanCore.sol";
import "../interfaces/IFeeController.sol";

import {
    OCR_ZeroAddress,
    OCR_InvalidState,
    OCR_TooEarly,
    OCR_InterestRate,
    OCR_AprTooHigh,
    OCR_LoanDuration,
    OCR_CollateralMismatch,
    OCR_CurrencyMismatch,
    OCR_DailyInterestRate,
    OCR_PrincipalDifferenceOne,
    OCR_PrincipalDifferenceTen
} from "../errors/Lending.sol";


/**
 * @title OriginationControllerRefinance
 * @author Non-Fungible Technologies, Inc.
 *
 * This Origination Controller contract is responsible for the refinancing of active loans.
 * Refinancing is the process of replacing an existing loan with a new loan that has a lower APR.
 */
contract OriginationControllerRefinance is IOriginationControllerRefinance, InterestCalculator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IOriginationSharedStorage public immutable sharedStorage;
    ILoanCore public immutable loanCore;
    IFeeController public immutable feeController;

    constructor(address _sharedStorage, address _loanCore, address _feeController) {
        if (_sharedStorage == address(0)) revert OCR_ZeroAddress("_sharedStorage");
        if (_loanCore == address(0)) revert OCR_ZeroAddress("_loanCore");
        if (_feeController == address(0)) revert OCR_ZeroAddress("_feeController");

        sharedStorage = IOriginationSharedStorage(_sharedStorage);
        loanCore = ILoanCore(_loanCore);
        feeController = IFeeController(_feeController);
    }

    /**
     * @notice Refinances an active loan. This function can only be called by a new lender account.
     *         There is no signature required from the borrower. The new loan terms will be validated
     *         and the new loan will be created. The old loan will be closed and replaced by the new
     *         one. The new lender will pay the old lender the full repayment amount.
     *
     * @param loanId                             The ID of the loan to be refinanced.
     * @param newTerms                           The new loan terms.
     *
     * @return newLoanId                         The ID of the new loan.
     */
    function refinanceLoan(
        uint256 loanId,
        LoanLibrary.LoanTerms calldata newTerms
    ) external override nonReentrant returns (uint256 newLoanId) {
        LoanLibrary.LoanData memory data = loanCore.getLoan(loanId);

        // validate refinance
        {
            uint256 oldDueDate = data.startDate + data.terms.durationSecs;
            uint256 newDueDate = block.timestamp + newTerms.durationSecs;
            _validateRefinance(data, newTerms, oldDueDate, newDueDate);
            _validateRefinancePrincipal(data, newTerms, oldDueDate, newDueDate);
        }

        // refinancing actors
        address oldLender = IERC721(loanCore.lenderNote()).ownerOf(loanId);
        address borrower = IERC721(loanCore.borrowerNote()).ownerOf(loanId);

        // calculate refinancing amounts
        (OriginationLibrary.RefinanceAmounts memory amounts) = _calcRefinanceAmounts(data, newTerms.principal);

        // call loan core to close old loan, start the new one and transfer settled amounts
        newLoanId = loanCore.refinance(
            loanId,
            borrower,
            oldLender,
            msg.sender,
            newTerms,
            amounts.amountToOldLender,
            amounts.amountFromNewLender,
            amounts.amountToBorrower,
            amounts.interestAmount
        );
    }

    /**
     * @notice Validates the new loan terms for a refinanced loan. The new APR must be at least 5%
     *         lower than the old APR. The new due date cannot be shorter than the old due date and
     *         the collateral and payable currency must be the same.
     *
     * @param oldLoanData                        The loan data of the loan being refinanced.
     * @param newTerms                           The new loan terms.
     * @param oldDueDate                         The due date of the loan being refinanced.
     * @param newDueDate                         The due date of the new loan.
     */
    // solhint-disable-next-line code-complexity
    function _validateRefinance(
        LoanLibrary.LoanData memory oldLoanData,
        LoanLibrary.LoanTerms calldata newTerms,
        uint256 oldDueDate,
        uint256 newDueDate
    ) internal view {
        // cannot refinance a loan that has already been repaid
        if (oldLoanData.state != LoanLibrary.LoanState.Active) revert OCR_InvalidState(oldLoanData.state);

        // cannot refinance a loan before it has been active for 2 days
        if (block.timestamp < oldLoanData.startDate + 2 days) revert OCR_TooEarly(oldLoanData.startDate + 2 days);

        // interest rate must be greater than or equal to 0.01% and less or equal to 1,000,000%
        if (newTerms.interestRate < 1 || newTerms.interestRate > 1e8) revert OCR_InterestRate(newTerms.interestRate);

        // new interest rate APR must be lower than old interest rate by 5% minimum
        uint256 aprMinimumScaled = oldLoanData.terms.interestRate * Constants.BASIS_POINTS_DENOMINATOR -
            (oldLoanData.terms.interestRate * Constants.BASIS_POINTS_DENOMINATOR / 20);
        if (newTerms.interestRate * Constants.BASIS_POINTS_DENOMINATOR > aprMinimumScaled) revert OCR_AprTooHigh(aprMinimumScaled);

        // new due date cannot be shorter than old due date and must be shorter than 3 years
        if (newDueDate < oldDueDate || newTerms.durationSecs > Constants.MAX_LOAN_DURATION) revert OCR_LoanDuration(oldDueDate, newDueDate);

        // collateral must be the same
        if (
            newTerms.collateralAddress != oldLoanData.terms.collateralAddress ||
            newTerms.collateralId != oldLoanData.terms.collateralId
        ) revert OCR_CollateralMismatch(
            oldLoanData.terms.collateralAddress,
            oldLoanData.terms.collateralId,
            newTerms.collateralAddress,
            newTerms.collateralId
        );

        // payable currency must be the same
        if (newTerms.payableCurrency != oldLoanData.terms.payableCurrency) revert OCR_CurrencyMismatch(
            oldLoanData.terms.payableCurrency,
            newTerms.payableCurrency
        );
    }

    /**
     * @notice Validates the new principal amount for a refinanced loan. If the new principal is more
     *         than the old balance, the new daily interest rate must be less than the old daily interest
     *         rate. If the new principal is less than the old balance, the difference must be at least 1%
     *         of the old principal if the due date is the same, or 10% of the remaining loan duration if
     *         the due date is longer.
     *
     * @param oldLoanData                        The loan data of the loan being refinanced.
     * @param newTerms                           The new loan terms.
     * @param oldDueDate                         The due date of the loan being refinanced.
     * @param newDueDate                         The due date of the new loan.
     */
    function _validateRefinancePrincipal(
        LoanLibrary.LoanData memory oldLoanData,
        LoanLibrary.LoanTerms calldata newTerms,
        uint256 oldDueDate,
        uint256 newDueDate
    ) internal view {
        // new loan principal validation
        if (newTerms.principal > oldLoanData.balance) {
            // loan principal can only be increased if there is a net reduction in daily interest rate
            uint256 oldDailyInterestRate = getDailyInterestRate(oldLoanData.balance, oldLoanData.terms.interestRate);
            uint256 newDailyInterestRate = getDailyInterestRate(newTerms.principal, newTerms.interestRate);
            if (newDailyInterestRate >= oldDailyInterestRate) revert OCR_DailyInterestRate(oldDailyInterestRate, newDailyInterestRate);
        } else {
            uint256 principalDifference = oldLoanData.balance - newTerms.principal;
            // if new principal is less than old balance and due date is the same
            if (newDueDate == oldDueDate) {
                // the minimum improvement needed is 1% of old principal
                uint256 principalMinimumOne = oldLoanData.balance / 100;
                if (principalDifference < principalMinimumOne) revert OCR_PrincipalDifferenceOne(principalDifference, principalMinimumOne);
            } else {
                // if new loan has a longer due date, the minimum improvement needed is 10% of the remaining loan duration
                uint256 remainingDuration10 = (oldDueDate - block.timestamp) / 10;
                uint256 principalMinimumTen = remainingDuration10 * oldLoanData.balance / oldLoanData.terms.durationSecs;
                if (principalDifference < principalMinimumTen) revert OCR_PrincipalDifferenceTen(principalDifference, principalMinimumTen);
            }
        }
    }

    /**
     * @notice Calculates the amounts to be transferred between the old lender, new lender and borrower. if the
     *         new principal is less than the old balance, the new lender must supply the difference. If the new
     *         principal is greater than the old balance, the borrower receives the difference. The new lender
     *         will always have to pay the interest due to the old lender plus the new principal amount.
     *
     * @param oldLoanData                        The loan data of the loan being refinanced.
     * @param newTermsPrincipal                  The new loan terms principal amount
     *
     * @return amounts                           The net amounts owed to each party.
     */
    function _calcRefinanceAmounts(
        LoanLibrary.LoanData memory oldLoanData,
        uint256 newTermsPrincipal
    ) internal view returns (OriginationLibrary.RefinanceAmounts memory amounts) {
        // calculate current interest amount due to old lender
        uint256 oldInterestAmount = getProratedInterestAmount(
            oldLoanData.balance,
            oldLoanData.terms.interestRate,
            oldLoanData.terms.durationSecs,
            oldLoanData.startDate,
            oldLoanData.lastAccrualTimestamp,
            block.timestamp
        );

        // Calculate amount to be collected from the lender for new loan plus rollover fees
        uint256 interestFee = (oldInterestAmount * oldLoanData.feeSnapshot.lenderInterestFee) / Constants.BASIS_POINTS_DENOMINATOR;
        uint256 lenderFee = (oldLoanData.balance * oldLoanData.feeSnapshot.lenderPrincipalFee) / Constants.BASIS_POINTS_DENOMINATOR;

        return OriginationLibrary.refinancingAmounts(
            oldLoanData.balance,
            oldInterestAmount,
            newTermsPrincipal,
            interestFee,
            lenderFee
        );
    }
}
