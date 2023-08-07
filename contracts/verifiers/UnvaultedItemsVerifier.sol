// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../interfaces/ISignatureVerifier.sol";
import "../interfaces/IVaultFactory.sol";

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
    /// @dev Enum describing the collateral type of a signature item
    enum CollateralType {
        ERC_721,
        ERC_1155,
        ERC_20
    }

    /// @dev Enum describing each item that should be validated
    struct SignatureItem {
        // The type of collateral - which interface does it implement
        CollateralType cType;
        // The address of the collateral contract
        address asset;
        // The token ID of the collateral (only applicable to 721 and 1155).
        uint256 tokenId;
        // The minimum amount of collateral. For ERC721 assets, pass 1 or the
        // amount of assets needed to be held for a wildcard predicate. If the
        // tokenId is specified, the amount is assumed to be 1.
        uint256 amount;
        // Whether any token ID should be allowed. Only applies to ERC721.
        // Supersedes tokenId.
        bool anyIdAllowed;
    }

    // ==================================== COLLATERAL VERIFICATION =====================================

    /**
     * @notice Verify that the items specified by the predicate calldata match the loan terms
     *         based on reported collateral address and ID. In this case, we only need to compare
     *         parameters against each other - the protocol is enforcing that the specific collateral
     *         in this function's calldata will be custodied.
     *
     * @param collateralAddress             The address of the loan's collateral.
     * @param collateralId                  The tokenId of the loan's collateral.
     * @param predicates                    The calldata needed for the verifier.
     *
     * @return verified                     Whether the bundle contains the specified items.
     */
    function verifyPredicates(
        address,
        address,
        address collateralAddress,
        uint256 collateralId,
        bytes calldata predicates
    ) external view override returns (bool) {
        // Unpack items
        (address token, uint256 tokenId, bool anyIdAllowed) = decodeData(predicates);

        //No asset provided
        if (token == address(0)) revert IV_ItemMissingAddress();

        // Check for collateral address match - should never happen, given that
        // the collateral address is also part of the loan signature
        if (token != collateralAddress) return false;

        // Check for tokenId match if not using wildcard
        if (!anyIdAllowed && tokenId != collateralId) return false;

        return true;
    }

    /**
     * @notice TODO: add natspce
     */
    function decodeData(bytes memory data)
        public
        pure
        returns (
            address,
            uint256,
            bool
        )
    {
        SignatureItem[] memory items = abi.decode(data, (SignatureItem[]));

        require(items.length > 0, "No items to decode");
        return (items[0].asset, items[0].tokenId, items[0].anyIdAllowed);
    }
}
