// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

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
    OCR_InvalidInterestChange
} from "../errors/Lending.sol";


/**
 * @title OriginationControllerRefinance
 * @author Non-Fungible Technologies, Inc.
 *
 * This Origination Controller contract is responsible for the refinancing of active loans.
 * Refinancing is the process of replacing an existing loan with a new loan that has a lower APR.
 */
contract OriginationControllerRefinance is IOriginationControllerRefinance, InterestCalculator, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    /// @notice The minimum reduction in APR for a refinanced loan in bps
    uint256 public MINIMUM_INTEREST_CHANGE = 500; // 5%

    /// @notice The lending protocol contracts
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
        _validateRefinance(data, newTerms);

        if (newTerms.principal > data.balance) {
            _validateRefinancePrincipal(
                data.balance,
                data.terms.interestRate,
                newTerms.principal,
                newTerms.interestRate
            );
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
     * @notice Sets the minimum interest rate reduction for a refinanced loan. New amount must be
     *         between 0.01% (1) and 10% (1000).
     *
     * @param _minimumInterestChange             New minimum interest rate reduction in bps.
     */
    function setMinimumInterestChange(uint256 _minimumInterestChange) external override onlyOwner {
        if (_minimumInterestChange < 1) revert OCR_InvalidInterestChange();
        if (_minimumInterestChange > 1000) revert OCR_InvalidInterestChange();

        MINIMUM_INTEREST_CHANGE = _minimumInterestChange;

        emit SetMinimumInterestChange(_minimumInterestChange);
    }

    /**
     * @notice Validates the new loan terms for a refinanced loan. The new APR must be at least 5%
     *         lower than the old APR. The new due date cannot be shorter than the old due date and
     *         the collateral and payable currency must be the same.
     *
     * @param oldLoanData                        The loan data of the loan being refinanced.
     * @param newTerms                           The new loan terms.
     */
    // solhint-disable-next-line code-complexity
    function _validateRefinance(
        LoanLibrary.LoanData memory oldLoanData,
        LoanLibrary.LoanTerms calldata newTerms
    ) internal view {
        // cannot refinance a loan that has already been repaid
        if (oldLoanData.state != LoanLibrary.LoanState.Active) revert OCR_InvalidState(oldLoanData.state);

        // cannot refinance a loan before it has been active for 2 days
        if (block.timestamp < oldLoanData.startDate + 2 days) revert OCR_TooEarly(oldLoanData.startDate + 2 days);

        // interest rate must be greater than or equal to 0.01% and less or equal to 1,000,000%
        if (newTerms.interestRate < 1 || newTerms.interestRate > 1e8) revert OCR_InterestRate(newTerms.interestRate);

        // new interest rate APR must be lower than old interest rate by minimum
        uint256 aprMinimumScaled = oldLoanData.terms.interestRate * Constants.BASIS_POINTS_DENOMINATOR -
            (oldLoanData.terms.interestRate * MINIMUM_INTEREST_CHANGE);
        if (newTerms.interestRate * Constants.BASIS_POINTS_DENOMINATOR > aprMinimumScaled) revert OCR_AprTooHigh(aprMinimumScaled);

        uint256 oldDueDate = oldLoanData.startDate + oldLoanData.terms.durationSecs;
        uint256 newDueDate = block.timestamp + newTerms.durationSecs;
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
     *         rate.
     *
     * @param oldLoanBalance                     The balance of the loan being refinanced.
     * @param oldLoanInterestRate                The interest rate of the loan being refinanced.
     * @param newTermsPrincipal                  The new loan terms principal amount
     * @param newTermsInterestRate               The new loan terms interest rate
     */
    function _validateRefinancePrincipal(
        uint256 oldLoanBalance,
        uint256 oldLoanInterestRate,
        uint256 newTermsPrincipal,
        uint256 newTermsInterestRate
    ) internal pure {
        uint256 oldDailyRate = getDailyInterestRate(oldLoanBalance, oldLoanInterestRate);
        uint256 newDailyRate = getDailyInterestRate(newTermsPrincipal, newTermsInterestRate);

        if (newDailyRate >= oldDailyRate) revert OCR_DailyInterestRate(oldDailyRate, newDailyRate);
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
