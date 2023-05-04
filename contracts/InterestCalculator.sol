// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import { FIAC_InterestRate } from "./errors/Lending.sol";

/**
 * @title InterestCalculator
 * @author Non-Fungible Technologies, Inc.
 *
 * Interface for calculating the interest amount
 * given an interest rate and principal amount. Assumes
 * that the interestRate is already expressed over the desired
 * time period.
 */
abstract contract InterestCalculator {
    // ============================================ STATE ==============================================

    /// @dev The units of precision equal to the minimum interest of 1 basis point.
    uint256 public constant INTEREST_RATE_DENOMINATOR = 1e18;
    /// @dev The denominator to express the final interest in terms of basis ponits.
    uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;

    // ======================================== CALCULATIONS ===========================================

    /**
     * @notice Calculate the interest due over a full term.
     *
     * @dev Interest and principal must be entered with 18 units of
     *      precision from the basis point unit (e.g. 1e18 == 0.01%)
     *
     * @param principal                  Principal amount in the loan terms.
     * @param interestRate               Interest rate in the loan terms.
     *
     * @return interest                  The amount of interest due.
     */
    function getFullInterestAmount(uint256 principal, uint256 interestRate) public pure returns (uint256) {
        // Interest rate to be greater than or equal to 0.01%
        if (interestRate / INTEREST_RATE_DENOMINATOR < 1) revert FIAC_InterestRate(interestRate);

        return principal + principal * interestRate / INTEREST_RATE_DENOMINATOR / BASIS_POINTS_DENOMINATOR;
    }
}
