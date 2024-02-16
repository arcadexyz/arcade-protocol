// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";

import "../libraries/LoanLibrary.sol";

import "../interfaces/IOriginationController.sol";

/**
 * @title OriginationLibrary
 * @author Non-Fungible Technologies, Inc.
 *
 * Library for loan origination functions.
 */
library OriginationLibrary {
    // ======================================= STRUCTS ================================================

    struct Currency {
        bool isAllowed;
        uint256 minPrincipal;
    }

    struct RolloverAmounts {
        uint256 needFromBorrower;
        uint256 leftoverPrincipal;
        uint256 amountFromLender;
        uint256 amountToOldLender;
        uint256 amountToLender;
        uint256 amountToBorrower;
        uint256 interestAmount;
    }

    struct OperationData {
        uint256 oldLoanId;
        LoanLibrary.LoanTerms newLoanTerms;
        address borrower;
        address lender;
        RolloverAmounts migrationAmounts;
    }

    // ======================================= CONSTANTS ==============================================

    /// @notice EIP712 type hash for bundle-based signatures.
    bytes32 public constant _TOKEN_ID_TYPEHASH =
        keccak256(
            // solhint-disable-next-line max-line-length
            "LoanTerms(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,uint256 collateralId,bytes32 affiliateCode,SigProperties sigProperties,uint8 side,address signingCounterparty)SigProperties(uint160 nonce,uint96 maxUses)"
        );

    /// @notice EIP712 type hash for item-based signatures.
    bytes32 public constant _ITEMS_TYPEHASH =
        keccak256(
            // solhint-disable max-line-length
            "LoanTermsWithItems(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,bytes32 affiliateCode,Predicate[] items,SigProperties sigProperties,uint8 side,address signingCounterparty)Predicate(bytes data,address verifier)SigProperties(uint160 nonce,uint96 maxUses)"
        );

    /// @notice EIP712 type hash for Predicate.
    bytes32 public constant _PREDICATE_TYPEHASH =
        keccak256(
            "Predicate(bytes data,address verifier)"
        );

    /// @notice EIP712 type hash for SigProperties.
    bytes32 public constant _SIG_PROPERTIES_TYPEHASH =
        keccak256(
            "SigProperties(uint160 nonce,uint96 maxUses)"
        );

    // ==================================== SIGNATURE VERIFICATION ====================================

    /**
     * @notice Hashes each item in Predicate[] separately and concatenates these hashes for
     *         inclusion in _ITEMS_TYPEHASH.
     *
     * @dev Solidity does not support array or nested struct hashing in the keccak256 function
     *      hence the multi-step hash creation process.
     *
     * @param predicates                    The predicate items array.
     *
     * @return itemsHash                    The concatenated hash of all items in the Predicate array.
     */
    function encodePredicates(LoanLibrary.Predicate[] memory predicates) public pure returns (bytes32 itemsHash) {
       bytes32[] memory itemHashes = new bytes32[](predicates.length);

        for (uint i = 0; i < predicates.length;){
            itemHashes[i] = keccak256(
                abi.encode(
                    _PREDICATE_TYPEHASH,
                    keccak256(predicates[i].data),
                    predicates[i].verifier
                )
            );

            // Predicates is calldata, overflow is impossible bc of calldata
            // size limits vis-a-vis gas
            unchecked {
                i++;
            }
        }

        // concatenate all predicate hashes
        itemsHash = keccak256(abi.encodePacked(itemHashes));
    }

    /**
     * @notice Hashes the signature properties for inclusion in the EIP712 signature.
     *
     * @param sigProperties                 The signature properties.
     *
     * @return sigPropertiesHash            The hash of the signature properties.
     */
    function encodeSigProperties(IOriginationController.SigProperties memory sigProperties) public pure returns (bytes32 sigPropertiesHash) {
        sigPropertiesHash = keccak256(
            abi.encode(
                _SIG_PROPERTIES_TYPEHASH,
                sigProperties.nonce,
                sigProperties.maxUses
            )
        );
    }

    // ==================================== PERMISSION MANAGEMENT =====================================

    /**
     * @notice Reports whether the signer matches the target or is approved by the target.
     *
     * @param target                        The grantor of permission - should be a smart contract.
     * @param sig                           A struct containing the signature data (for checking EIP-1271).
     * @param sighash                       The hash of the signature payload (used for EIP-1271 check).
     *
     * @return bool                         Whether the signer is either the grantor themselves, or approved.
     */
    function isApprovedForContract(
        address target,
        IOriginationController.Signature memory sig,
        bytes32 sighash
    ) public view returns (bool) {
        bytes memory signature = abi.encodePacked(sig.r, sig.s, sig.v);

        // Append extra data if it exists
        if (sig.extraData.length > 0) {
            signature = bytes.concat(signature, sig.extraData);
        }

        // Convert sig struct to bytes
        (bool success, bytes memory result) = target.staticcall(
            abi.encodeWithSelector(IERC1271.isValidSignature.selector, sighash, signature)
        );
        return (success && result.length == 32 && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector));
    }
}