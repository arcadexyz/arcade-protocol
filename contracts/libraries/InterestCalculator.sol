// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "./Constants.sol";

/**
 * @title InterestCalculator
 * @author Non-Fungible Technologies, Inc.
 *
 * Interface for calculating the prorated interest amount
 * given the loan terms, current timestamp, and any previous repayments.
 *
 * Also included is a function to calculate the effective interest rate
 * of a loan, which can be useful for borrowers and lenders to understand
 * the true cost of a loan.
 */
abstract contract InterestCalculator {
    // ======================================== CALCULATIONS ===========================================

    /**
     * @notice Calculate the prorated interest due for a loan. Takes the loan's unpaid
     *         principal and calculates the total interest due based on the prorated
     *         interest rate.
     *
     * @param balance                               The unpaid principal of the loan
     * @param interestRate                          Interest rate in the loan terms
     * @param loanDuration                          Duration of the loan in seconds
     * @param loanStartTime                         Start timestamp of the loan
     * @param lastAccrualTimestamp                  Last interest accrual timestamp
     * @param currentTimestamp                      Current timestamp
     *
     * @return interestAmountDue                    The amount of interest due
     */
    function getProratedInterestAmount(
        uint256 balance,
        uint256 interestRate,
        uint256 loanDuration,
        uint256 loanStartTime,
        uint256 lastAccrualTimestamp,
        uint256 currentTimestamp
    ) public pure returns (uint256 interestAmountDue) {
        // time since loan start
        uint256 timeSinceStart = currentTimestamp - loanStartTime;

        // time since last payment
        uint256 timeSinceLastPayment;
        if (timeSinceStart > loanDuration) {
            // if time elapsed is greater than loan duration, set it to loan duration
            uint256 endTimestamp = loanStartTime + loanDuration;

            // if the borrower paid interest after the loan has ended, zero interest is due
            if (lastAccrualTimestamp >= endTimestamp) {
                return 0;
            }

            timeSinceLastPayment = endTimestamp - lastAccrualTimestamp;
        } else {
            timeSinceLastPayment = currentTimestamp - lastAccrualTimestamp;
        }

        interestAmountDue = balance * timeSinceLastPayment * interestRate
            / (Constants.BASIS_POINTS_DENOMINATOR * Constants.SECONDS_IN_YEAR);
    }

    /**
     * @notice Calculate the effective interest rate for a loan. The effective interest
     *         rate is the actual interest rate paid on a loan, considering interest the
     *         repayments made thus far.
     *
     * @param totalInterestAmountPaid               The total interest paid on the loan
     * @param totalTimeElapsed                      The total time elapsed since the loan started
     * @param loanPrincipal                         The principal of the loan
     *
     * @return effectiveInterestRate                The effective interest rate
     */
    function effectiveInterestRate(
        uint256 totalInterestAmountPaid,
        uint256 totalTimeElapsed,
        uint256 loanPrincipal
    ) public pure returns (uint256) {
        return (totalInterestAmountPaid * Constants.SECONDS_IN_YEAR * Constants.BASIS_POINTS_DENOMINATOR)
            / (totalTimeElapsed * loanPrincipal);
    }

    /**
     * @notice Calculate the effective interest rate for a loan, if the loan principal is
     *         to be repaid in full at a given timestamp.
     *
     * @param balance                               The unpaid principal of the loan
     * @param loanPrincipal                         The principal of the loan
     * @param totalInterestAmountPaid               The total interest paid on the loan
     * @param interestRate                          Interest rate in the loan terms
     * @param loanDuration                          Duration of the loan in seconds
     * @param loanStartTime                         Start timestamp of the loan
     * @param lastAccrualTimestamp                  Last interest accrual timestamp
     * @param currentTimestamp                      Current timestamp
     *
     * @return effectiveInterestRate                The effective interest rate
     */
    function closeNowEffectiveInterestRate(
        uint256 balance,
        uint256 loanPrincipal,
        uint256 totalInterestAmountPaid,
        uint256 interestRate,
        uint256 loanDuration,
        uint256 loanStartTime,
        uint256 lastAccrualTimestamp,
        uint256 currentTimestamp
    ) public pure returns (uint256) {
        uint256 interestAmountDue = getProratedInterestAmount(
            balance,
            interestRate,
            loanDuration,
            loanStartTime,
            lastAccrualTimestamp,
            currentTimestamp
        );

        return effectiveInterestRate(
            totalInterestAmountPaid + interestAmountDue,
            currentTimestamp - loanStartTime,
            loanPrincipal
        );
    }
}
