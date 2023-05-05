// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

interface IFeeController {
    // ================ Events =================

    event SetFee(bytes32 indexed selector, uint256 fee);

    // ================ Getter/Setter =================

    function get(bytes32 selector) external view returns (uint256);

    function set(bytes32 selector, uint256 fee) external;

    function getMaxFee(bytes32 selector) external view returns (uint256);
}
