// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

interface IRepaymentController {
    // ============== Lifecycle Operations ==============

    function repay(uint256 loanId, uint256 amount) external;

    function repayFull(uint256 loanId) external;

    function forceRepay(uint256 loanId, uint256 amount) external;

    function claim(uint256 loanId) external;

    function redeemNote(uint256 loanId, address to) external;
}
