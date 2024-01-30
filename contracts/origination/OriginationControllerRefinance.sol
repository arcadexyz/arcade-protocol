// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./OriginationCalculator.sol";

import "../libraries/OriginationLibrary.sol";
import "../libraries/LoanLibrary.sol";
import "../libraries/Constants.sol";

import "../interfaces/IOriginationControllerRefinance.sol";
import "../interfaces/IOriginationConfiguration.sol";
import "../interfaces/ILoanCore.sol";
import "../interfaces/IFeeController.sol";

import {
    OCR_ZeroAddress,
    OCR_InvalidState,
    OCR_TooEarly,
    OCR_InterestRate,
    OCR_LoanDuration,
    OCR_CollateralMismatch,
    OCR_CurrencyMismatch,
    OCR_SameLender,
    OCR_PrincipalIncrease
} from "../errors/Lending.sol";


/**
 * @title OriginationControllerRefinance
 * @author Non-Fungible Technologies, Inc.
 *
 * This Origination Controller contract is responsible for the refinancing of active loans.
 * Refinancing is the process of replacing an existing loan with a new loan that has a lower APR.
 */
contract OriginationControllerRefinance is IOriginationControllerRefinance, OriginationCalculator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The minimum reduction in APR for a refinanced loan in bps
    uint256 public constant MINIMUM_INTEREST_CHANGE = 1000; // 10%

    /// @notice The lending protocol contracts
    IOriginationConfiguration public immutable originationConfig;
    ILoanCore public immutable loanCore;
    IFeeController public immutable feeController;

    constructor(address _originationConfig, address _loanCore, address _feeController) {
        if (_originationConfig == address(0)) revert OCR_ZeroAddress("_originationConfig");
        if (_loanCore == address(0)) revert OCR_ZeroAddress("_loanCore");
        if (_feeController == address(0)) revert OCR_ZeroAddress("_feeController");

        originationConfig = IOriginationConfiguration(_originationConfig);
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
    ) external override returns (uint256 newLoanId) {
        LoanLibrary.LoanData memory data = loanCore.getLoan(loanId);

        // validate refinance
        _validateRefinance(data, newTerms);

        address borrower = IERC721(loanCore.borrowerNote()).ownerOf(loanId);

        newLoanId = _refinance(
            loanId,
            newTerms,
            borrower,
            msg.sender
        );
    }

    /**
     * @notice Validates the new loan terms for a refinanced loan. The new APR must be at least 5%
     *         lower than the old APR. The new principal amount cannot be larger. The new due date
     *         cannot be shorter than the old due date and the collateral and payable currency must
     *         be the same.
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

        // new interest rate APR must be lower than old interest rate by minimum
        uint256 aprMinimumScaled = oldLoanData.terms.interestRate * Constants.BASIS_POINTS_DENOMINATOR -
            (oldLoanData.terms.interestRate * MINIMUM_INTEREST_CHANGE);
        if (
            newTerms.interestRate < 1 ||
            newTerms.interestRate * Constants.BASIS_POINTS_DENOMINATOR > aprMinimumScaled
        ) revert OCR_InterestRate(aprMinimumScaled);

        // new due date cannot be shorter than old due date and must be shorter than 3 years
        uint256 oldDueDate = oldLoanData.startDate + oldLoanData.terms.durationSecs;
        uint256 newDueDate = block.timestamp + newTerms.durationSecs;
        if (
            newDueDate < oldDueDate ||
            newTerms.durationSecs > Constants.MAX_LOAN_DURATION
        ) revert OCR_LoanDuration(oldDueDate, newDueDate);

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

        // principal cannot increase
        if (newTerms.principal > oldLoanData.terms.principal) revert OCR_PrincipalIncrease(
            oldLoanData.terms.principal,
            newTerms.principal
        );
    }

    /**
     * @notice Perform loan rollover. Take custody of principal, and tell LoanCore to
     *         roll over the existing loan.
     *
     * @param oldLoanId                     The ID of the loan to be refinanced.
     * @param newTerms                      The new loan terms.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the new lender.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function _refinance(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata newTerms,
        address borrower,
        address lender
    ) internal nonReentrant returns (uint256 loanId) {
        LoanLibrary.LoanData memory oldLoanData = loanCore.getLoan(oldLoanId);

        address oldLender = ILoanCore(loanCore).lenderNote().ownerOf(oldLoanId);
        if (lender == oldLender) revert OCR_SameLender(lender);

        IERC20 payableCurrency = IERC20(newTerms.payableCurrency);

        // Calculate settle amounts
        OriginationLibrary.RolloverAmounts memory amounts = _calculateRolloverAmounts(
            oldLoanData,
            newTerms.principal,
            lender,
            oldLender,
            feeController
        );

        // Collect funds based on settle amounts and total them
        uint256 newLenderOwes = amounts.amountFromLender + amounts.needFromBorrower;
        payableCurrency.safeTransferFrom(lender, address(this), newLenderOwes);

        // approve LoanCore to take the total settled amount
        payableCurrency.safeApprove(address(loanCore), newLenderOwes);

        loanId = ILoanCore(loanCore).rollover(
            oldLoanId,
            oldLender,
            borrower,
            lender,
            newTerms,
            newLenderOwes,
            amounts.amountToOldLender,
            0,
            0,
            amounts.interestAmount
        );
    }
}
