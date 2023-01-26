// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "../vault/VaultFactory.sol";

contract VaultFactoryV2 is VaultFactory {
    uint256 public newStorageValue;

    function setNewStorageValue(uint256 _newStorageValue) external {
        newStorageValue = _newStorageValue;
    }

    function getNewStorageValue() public view returns(uint256) {
        return newStorageValue;
    }

    function version() public pure returns (string memory) {
        return "This is VaultFactory V2!";
    }
}
