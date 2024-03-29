// SPDX-License-Identifier: MIT

import "../libraries/LoanLibrary.sol";

pragma solidity 0.8.18;

interface IFeeController {
    // ================ Events =================

    event SetLendingFee(bytes32 indexed id, uint16 fee);

    event SetVaultMintFee(uint64 fee);

    // ================ Getter/Setter =================

    function setLendingFee(bytes32 id, uint16 fee) external;

    function setVaultMintFee(uint64 fee) external;

    function getLendingFee(bytes32 id) external view returns (uint16);

    function getVaultMintFee() external view returns (uint64);

    function getFeeSnapshot() external view returns (LoanLibrary.FeeSnapshot memory feeSnapshot);

    function getMaxLendingFee(bytes32 id) external view returns (uint16);

    function getMaxVaultMintFee() external view returns (uint64);
}