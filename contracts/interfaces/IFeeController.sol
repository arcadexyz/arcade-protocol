// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

interface IFeeController {
    // ================ Events =================

    event SetFee(bytes32 indexed id, uint64 fee);

    // ================ Getter/Setter =================

    function set(bytes32 id, uint16 fee) external;

    function setVaultFee(bytes32 id, uint64 fee) external;
    
    function get(bytes32 id) external view returns (uint16);

    function getVaultFee(bytes32 id) external view returns (uint64);

    function getMaxFee(bytes32 id) external view returns (uint16);

    function getMaxVaultFee(bytes32 id) external view returns (uint64);
}