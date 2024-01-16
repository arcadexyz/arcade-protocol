// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

interface IRepaymentControllerV3 {
    // ============== Lifecycle Operations ==============

    function repay(uint256 loanId) external;

    function forceRepay(uint256 loanId) external;

    function claim(uint256 loanId) external;

    function redeemNote(uint256 loanId, address to) external;

    // ============== View Functions ==============

    function getInterestAmount(uint256 prinicpal, uint256 proratedInterestRate) external view returns (uint256);
}