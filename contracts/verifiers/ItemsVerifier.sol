// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "../interfaces/IVaultFactory.sol";
import "../interfaces/IAssetVault.sol";
import "../interfaces/ISignatureVerifier.sol";
import "../libraries/LoanLibrary.sol";

import { IV_ItemMissingAddress, IV_InvalidCollateralType, IV_NonPositiveAmount1155, IV_InvalidTokenId1155, IV_NonPositiveAmount20 } from "../errors/Lending.sol";

/**
 * @title ArcadeItemsVerifier
 * @author Non-Fungible Technologies, Inc.
 *
 * This contract can be used for verifying complex signature-encoded
 * bundle descriptions. This resolves on a new array of SignatureItems[],
 * which outside of verification, is passed around as bytes memory.
 *
 * Each SignatureItem has four fields:
 *      - cType (collateral Type)
 *      - asset (contract address of the asset)
 *      - tokenId (token ID of the asset, if applicable)
 *      - amount (amount of the asset, if applicable)
 *
 * - For token ids part of ERC721, other features beyond direct tokenIds are supported:
 *      - A provided token id of -1 is a wildcard, meaning any token ID is accepted.
 *      - Wildcard token ids are not supported for ERC1155.
 * - All amounts are taken as minimums. For instance, if the "amount" field of an ERC1155 is 5,
 *      then a bundle with 8 of those ERC1155s are accepted.
 * - For an ERC20 cType, tokenId is ignored. For an ERC721 cType, amount is ignored.
 *
 * - Any deviation from the above rules represents an unparseable signature and will always
 *      return invalid.
 *
 * - All multi-item signatures assume AND - any optional expressed by OR
 *      can be implemented by simply signing multiple separate signatures.
 */
contract ArcadeItemsVerifier is ISignatureVerifier {
    using SafeCast for int256;

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
        // The token ID of the collateral (only applicable to 721 and 1155)
        // int256 because a negative value serves as wildcard
        int256 tokenId;
        // The minimum amount of collateral (only applicable for 20 and 1155)
        uint256 amount;
    }

    // ==================================== COLLATERAL VERIFICATION =====================================

    /**
     * @notice Verify that the items specified by the packed SignatureItem array are held by the vault.
     * @dev    Reverts on a malformed SignatureItem, returns false on missing contents.
     *
     *         Verification for empty predicates array has been addressed in initializeLoanWithItems and
     *         rolloverLoanWithItems.
     *
     * @param predicates                    The SignatureItem[] array of items, packed in bytes.
     * @param vault                         The vault that should own the specified items.
     *
     * @return verified                     Whether the bundle contains the specified items.
     */
    // solhint-disable-next-line code-complexity
    function verifyPredicates(bytes calldata predicates, address vault) external view override returns (bool) {
        // Unpack items
        SignatureItem[] memory items = abi.decode(predicates, (SignatureItem[]));

        uint256 numItems = items.length;
        for (uint256 i = 0; i < numItems; ++i) {
            SignatureItem memory item = items[i];

            // No asset provided
            if (item.asset == address(0)) revert IV_ItemMissingAddress();

            if (item.cType == CollateralType.ERC_721) {
                IERC721 asset = IERC721(item.asset);
                int256 id = item.tokenId;

                // Wildcard, but vault has no assets
                if (id < 0 && asset.balanceOf(vault) == 0) return false;
                // Does not own specifically specified asset
                else if (id >= 0 && asset.ownerOf(id.toUint256()) != vault) return false;
            } else if (item.cType == CollateralType.ERC_1155) {
                IERC1155 asset = IERC1155(item.asset);

                int256 id = item.tokenId;
                uint256 amt = item.amount;

                // Cannot require 0 amount
                if (amt == 0) revert IV_NonPositiveAmount1155(item.asset, amt);

                // Wildcard not allowed for 1155
                if (id < 0) revert IV_InvalidTokenId1155(item.asset, id);

                // Does not own specifically specified asset
                if (asset.balanceOf(vault, id.toUint256()) < amt) return false;
            } else if (item.cType == CollateralType.ERC_20) {
                IERC20 asset = IERC20(item.asset);

                uint256 amt = item.amount;

                // Cannot require 0 amount
                if (amt == 0) revert IV_NonPositiveAmount20(item.asset, amt);

                // Does not own specifically specified asset
                if (asset.balanceOf(vault) < amt) return false;
            } else {
                // Interface could not be parsed - fail
                revert IV_InvalidCollateralType(item.asset, uint256(item.cType));
            }
        }

        // Loop completed - all items found
        return true;
    }
}
