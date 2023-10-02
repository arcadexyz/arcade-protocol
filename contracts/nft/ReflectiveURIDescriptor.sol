// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "../interfaces/INFTDescriptor.sol";

/**
 * @title BaseURIDescriptor
 * @author Non-Fungible Technologies, Inc.
 *
 * Basic descriptor contract for an NFT, that uses a baseURI, and returns a tokenURI
 * for the requested token ID.
 */
contract ReflectiveURIDescriptor is INFTDescriptor, Ownable {
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
     * @param target              The address of the contract to get the URI for.
     * @param tokenId               The ID of the token to get the URI for.
     *
     * @return uri                  The token ID's URI.
     */
    function tokenURI(address target, uint256 tokenId) external view override returns (string memory) {
        if (bytes(baseURI).length == 0) return "";

        return string(
            abi.encodePacked(
                baseURI,
                Strings.toHexString(uint160(target), 20),
                "/metadata/",
                tokenId.toString()
            )
        );
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
