// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

interface INFTDescriptor {
    function tokenURI(address token, uint256 tokenId) external view returns (string memory);
}