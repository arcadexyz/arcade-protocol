// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

library Constants {
    /// @dev Denominator used to annualize interest rates
    uint256 constant SECONDS_IN_YEAR = 365 days;

    /// @dev Denominator for interest rate in basis points
    uint256 constant BASIS_POINTS_DENOMINATOR = 1e4;

    /// @dev Max split any affiliate can earn
    uint96 constant MAX_AFFILIATE_SPLIT = 50_00;

    /// @dev Grace period for repaying a loan after loan duration
    uint256 constant GRACE_PERIOD = 10 minutes;

    /// @notice The max number of items that can be withdrawn from an asset vault at one time
    uint256 constant MAX_WITHDRAW_ITEMS = 25;
}