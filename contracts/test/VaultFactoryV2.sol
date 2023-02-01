// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "../vault/VaultFactory.sol";

contract VaultFactoryV2 is VaultFactory {
    function version() public pure returns (string memory) {
        return "This is VaultFactory V2!";
    }
}
