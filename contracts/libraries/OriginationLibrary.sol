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
            "Loan(LoanTerms terms,SigProperties sigProperties,uint8 side,address signingCounterparty,bytes callbackData)LoanTerms(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,uint256 collateralId,bytes32 affiliateCode)SigProperties(uint160 nonce,uint96 maxUses)"
        );

    /// @notice EIP712 type hash for LoanTerms.
    bytes32 public constant _LOAN_TERMS_TYPEHASH =
        keccak256(
            // solhint-disable-next-line max-line-length
            "LoanTerms(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,uint256 collateralId,bytes32 affiliateCode)"
        );

    /// @notice EIP712 type hash for item-based signatures.
    bytes32 public constant _ITEMS_TYPEHASH =
        keccak256(
            // solhint-disable max-line-length
            "LoanWithItems(LoanTermsWithItems termsWithItems,SigProperties sigProperties,uint8 side,address signingCounterparty,bytes callbackData)LoanTermsWithItems(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,bytes32 affiliateCode,Predicate[] items)Predicate(bytes data,address verifier)SigProperties(uint160 nonce,uint96 maxUses)"
        );

    /// @notice EIP712 type hash for LoanTermsWithItems.
    bytes32 public constant _LOAN_TERMS_WITH_ITEMS_TYPEHASH =
        keccak256(
            // solhint-disable-next-line max-line-length
            "LoanTermsWithItems(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,bytes32 affiliateCode,Predicate[] items)Predicate(bytes data,address verifier)"
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

    /**
     * @notice Hashes the loan terms for inclusion in the EIP712 signature.
     *
     * @param terms                         The loan terms.
     *
     * @return termsHash                    The hash of the loan terms.
     */
    function encodeLoanTerms(LoanLibrary.LoanTerms calldata terms) public pure returns (bytes32 termsHash) {
        termsHash = keccak256(
            abi.encode(
                _LOAN_TERMS_TYPEHASH,
                terms.interestRate,
                terms.durationSecs,
                terms.collateralAddress,
                terms.deadline,
                terms.payableCurrency,
                terms.principal,
                terms.collateralId,
                terms.affiliateCode
            )
        );
    }

    /**
     * @notice Hashes the loan terms with items for inclusion in the EIP712 signature.
     *
     * @param terms                         The loan terms.
     * @param itemPredicatesHash            The hash of the item predicates.
     *
     * @return termsWithItemsHash           The hash of the loan terms with items.
     */
    function encodeLoanTermsWithItems(LoanLibrary.LoanTerms calldata terms, bytes32 itemPredicatesHash) public pure returns (bytes32 termsWithItemsHash) {
        termsWithItemsHash = keccak256(
            abi.encode(
                _LOAN_TERMS_WITH_ITEMS_TYPEHASH,
                terms.interestRate,
                terms.durationSecs,
                terms.collateralAddress,
                terms.deadline,
                terms.payableCurrency,
                terms.principal,
                terms.affiliateCode,
                itemPredicatesHash
            )
        );
    }

    /**
     * @notice Hashes the loan terms and signature properties for inclusion in the EIP712 signature.
     *
     * @param terms                         The loan terms.
     * @param sigProperties                 The signature properties.
     * @param side                          The side of the signature.
     * @param signingCounterparty           The address of the signing counterparty.
     * @param callbackData                  The borrower callback data.
     *
     * @return loanHash                     The hash of the loan terms and signature properties.
     */
    function encodeLoan(
        LoanLibrary.LoanTerms calldata terms,
        IOriginationController.SigProperties calldata sigProperties,
        uint8 side,
        address signingCounterparty,
        bytes memory callbackData
    ) public pure returns (bytes32 loanHash) {
        loanHash = keccak256(
            abi.encode(
                _TOKEN_ID_TYPEHASH,
                encodeLoanTerms(terms),
                encodeSigProperties(sigProperties),
                side,
                signingCounterparty,
                keccak256(callbackData)
            )
        );
    }

    /**
     * @notice Hashes the loan terms with items and signature properties for inclusion in the EIP712 signature.
     *
     * @param terms                         The loan terms.
     * @param itemPredicatesHash            The hash of the item predicates.
     * @param sigProperties                 The signature properties.
     * @param side                          The side of the signature.
     * @param signingCounterparty           The address of the signing counterparty.
     * @param callbackData                  The borrower callback data.
     *
     * @return loanWithItemsHash            The hash of the loan terms with items and signature properties.
     */
    function encodeLoanWithItems(
        LoanLibrary.LoanTerms calldata terms,
        bytes32 itemPredicatesHash,
        IOriginationController.SigProperties calldata sigProperties,
        uint8 side,
        address signingCounterparty,
        bytes memory callbackData
    ) public pure returns (bytes32 loanWithItemsHash) {
        loanWithItemsHash = keccak256(
            abi.encode(
                _ITEMS_TYPEHASH,
                encodeLoanTermsWithItems(terms, itemPredicatesHash),
                encodeSigProperties(sigProperties),
                side,
                signingCounterparty,
                keccak256(callbackData)
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