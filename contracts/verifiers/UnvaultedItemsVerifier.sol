// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../interfaces/IVaultFactory.sol";
import "../interfaces/IAssetVault.sol";
import "../interfaces/ISignatureVerifier.sol";
import "../libraries/LoanLibrary.sol";

import { IV_NoAmount, IV_InvalidWildcard, IV_ItemMissingAddress, IV_InvalidCollateralType } from "../errors/Lending.sol";

/**
 * @title UnvaultedItemsVerifier
 * @author Non-Fungible Technologies, Inc.
 *
 * This contract can be used for verifying a signature-encoded set
 * of requirements for the loan's collateral, expressed as a predicate encoded in calldata.
 *
 * The calldata parameter should be parsed for the following fields:
 *      - asset (contract address of the asset)
 *      - tokenId (token ID of the asset, if applicable)
 *      - anyIdAllowed (whether a wildcard is supported - see below)
 *
 * The above fields also include the requirement that the collateral be ERC721.
 * If anyIdAllowed is true, then any token ID can be passed - the field will be ignored.
 */
contract UnvaultedItemsVerifier is ISignatureVerifier {
    // ==================================== COLLATERAL VERIFICATION =====================================

    /**
     * @notice Verify that the items specified by the predicate calldata match the loan terms
     *         based on reported collateral address and ID. In this case, we only need to compare
     *         parameters against each other - the protocol is enforcing that the specific collateral
     *         in this function's calldata will be custodied.
     *
     * @param collateralAddress             The address of the loan's collateral.
     * @param collateralId                  The tokenId of the loan's collateral.
     * @param data                          The calldata needed for the verifier.
     *
     * @return verified                     Whether the bundle contains the specified items.
     */
    function verifyPredicates(
        address collateralAddress,
        uint256 collateralId,
        bytes calldata data
    ) external pure override returns (bool) {
        // Unpack items
        (address token, uint256 tokenId, bool anyIdAllowed) = abi.decode(data, (address, uint256, bool));

        // No asset provided
        if (token == address(0)) revert IV_ItemMissingAddress();

        // Check for collateral address match - should never happen, given that
        // the collateral address is also part of the loan signature
        if (token != collateralAddress) return false;

        // Check for tokenId match if not using wildcard
        if (!anyIdAllowed && tokenId != collateralId) return false;

        return true;
    }
}
