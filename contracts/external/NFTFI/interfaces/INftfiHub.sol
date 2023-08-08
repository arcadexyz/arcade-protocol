// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title INftfiHub
 * @author NFTfi
 * @dev NftfiHub interface
 */
interface INftfiHub {
    function setContract(string calldata _contractKey, address _contractAddress) external;

    function getContract(bytes32 _contractKey) external view returns (address);
}
