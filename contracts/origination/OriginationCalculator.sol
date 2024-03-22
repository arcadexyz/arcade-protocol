// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../interfaces/IFeeController.sol";

import "../libraries/LoanLibrary.sol";
import "../libraries/OriginationLibrary.sol";
import "../libraries/Constants.sol";
import "../libraries/InterestCalculator.sol";

/**
 * @title OriginationCalculator
 * @author Non-Fungible Technologies, Inc.
 *
 * Contract for calculating net settlement amounts.
 */
abstract contract OriginationCalculator is InterestCalculator {
    /**
     * @dev Calculate the net amounts needed from each party for a rollover or migration - the
     *      borrower, the new lender, and the old lender (can be same as new lender).
     *      Determine the amount to either pay or withdraw from the borrower, and
     *      any payments to be sent to the old lender.
     *
     * @param oldBalance            The balance of the old loan.
     * @param oldInterestAmount     The interest amount of the old loan.
     * @param newPrincipalAmount    The principal amount of the new loan.
     * @param lender                The address of the new lender.
     * @param oldLender             The address of the old lender.
     * @param principalFee          The fee taken from repaid principal.
     * @param interestFee           The fee taken from interest.
     *
     * @return amounts              The net amounts owed to each party.
     */
    function rolloverAmounts(
        uint256 oldBalance,
        uint256 oldInterestAmount,
        uint256 newPrincipalAmount,
        address lender,
        address oldLender,
        uint256 principalFee,
        uint256 interestFee
    ) public pure returns (OriginationLibrary.RolloverAmounts memory amounts) {
        amounts.amountFromLender = newPrincipalAmount;
        amounts.interestAmount = oldInterestAmount;

        uint256 repayAmount = oldBalance + oldInterestAmount;

        // Calculate net amounts based on if repayment amount for old loan is
        // greater than new loan principal
        if (repayAmount > newPrincipalAmount) {
            // amount to collect from borrower
            unchecked {
                amounts.needFromBorrower = repayAmount - newPrincipalAmount;
            }
        } else if (repayAmount < newPrincipalAmount) {
            // amount to collect from lender (either old or new)
            unchecked {
                amounts.leftoverPrincipal = newPrincipalAmount + interestFee + principalFee - repayAmount;
            }

            // amount to send to borrower
            unchecked {
                amounts.amountToBorrower = newPrincipalAmount - repayAmount;
            }
        } else {
            // no leftover principal, fees paid by the lender
            amounts.leftoverPrincipal = interestFee + principalFee;
            // no amount to collect from borrower
            amounts.needFromBorrower = 0;
        }

        // Calculate lender amounts based on if the lender is the same as the old lender
        if (lender != oldLender) {
            // different lenders, repay old lender
            amounts.amountToOldLender = repayAmount - interestFee - principalFee;

            // different lender, new lender is owed zero tokens
            amounts.amountToLender = 0;
        } else {
            // same lender
            amounts.amountToOldLender = 0;

            // same lender, so check if the amount to collect from the lender is less than
            // the amount the lender is owed for the old loan. If so, the lender is owed the
            // difference
            if (amounts.needFromBorrower > 0 && repayAmount > newPrincipalAmount) {
                unchecked {
                    amounts.amountToLender = repayAmount - newPrincipalAmount - interestFee - principalFee;
                }
            }
        }
    }

    /**
     * @dev Calculate the net amounts needed for the rollover from each party - the
     *      borrower, the new lender, and the old lender (can be same as new lender).
     *      Determine the amount to either pay or withdraw from the borrower, and
     *      any payments to be sent to the old lender.
     *
     * @param oldLoanData           The loan data struct for the old loan.
     * @param newPrincipalAmount    The principal amount for the new loan.
     * @param lender                The lender for the new loan.
     * @param oldLender             The lender for the existing loan.
     *
     * @return amounts              The net amounts owed to each party.
     */
    function _calculateRolloverAmounts(
        LoanLibrary.LoanData memory oldLoanData,
        uint256 newPrincipalAmount,
        address lender,
        address oldLender
    ) internal view returns (OriginationLibrary.RolloverAmounts memory) {
        // Calculate prorated interest amount for old loan
        uint256 interest = getProratedInterestAmount(
            oldLoanData.balance,
            oldLoanData.terms.interestRate,
            oldLoanData.terms.durationSecs,
            uint64(oldLoanData.startDate),
            uint64(oldLoanData.lastAccrualTimestamp),
            block.timestamp
        );

        // Calculate interest fee
        uint256 interestFee = (interest * oldLoanData.lenderInterestFee)
            / Constants.BASIS_POINTS_DENOMINATOR;
        uint256 principalFee = (oldLoanData.balance * oldLoanData.lenderPrincipalFee)
            / Constants.BASIS_POINTS_DENOMINATOR;

        return rolloverAmounts(
            oldLoanData.balance,
            interest,
            newPrincipalAmount,
            lender,
            oldLender,
            principalFee,
            interestFee
        );
    }
}