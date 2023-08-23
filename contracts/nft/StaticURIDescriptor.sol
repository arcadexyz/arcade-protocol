// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "../interfaces/INFTDescriptor.sol";

/**
 * @title StaticURIDescriptor
 * @author Non-Fungible Technologies, Inc.
 *
 * Basic descriptor contract for an NFT, that returns the same resource
 * for any requested token.
 */
contract StaticURIDescriptor is INFTDescriptor, Ownable {
    using Strings for uint256;

    event SetBaseURI(address indexed caller, string indexed baseURI);

    // ============================================ STATE ==============================================

    string public baseURI;

    // ========================================= CONSTRUCTOR ===========================================

    /**
     * @dev Creates a descriptor contract that allows a baseURI to be set,
     *      within token URIs enumerated from the base.
     *
     * @param _baseURI              The value of the baseURI state variable.
     */
    constructor(string memory _baseURI) {
        // Empty baseURI is allowed
        baseURI = _baseURI;
    }

    // ===================================== DESCRIPTOR OPERATIONAS ============================================

    /**
     * @notice Getter of specific URI for an ERC721 token ID.
     *
     * @return uri                  The token ID's URI, the contract's baseURI.
     */
    function tokenURI(address, uint256) external view override returns (string memory) {
        return baseURI;
    }

    /**
     * @notice An owner-only function for setting the string value of the base URI.
     *
     * @param newBaseURI              The new value of the base URI.
     */
    function setBaseURI(string memory newBaseURI) external onlyOwner {
        baseURI = newBaseURI;

        emit SetBaseURI(msg.sender, newBaseURI);
    }
}
