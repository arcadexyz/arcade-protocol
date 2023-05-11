// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

interface INFTDescriptor {
    event SetBaseURI(address indexed caller, string indexed baseURI);

    function tokenURI(address token, uint256 tokenId) external view returns (string memory);
}