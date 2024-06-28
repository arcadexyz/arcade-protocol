// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/LoanLibrary.sol";

import "../interfaces/IOriginationController.sol";

/**
 * @title OriginationLibrary
 * @author Non-Fungible Technologies, Inc.
 *
 * This library is a collection of shared logic used across various origination controller contracts.
 * It includes constants for EIP712 type hashes, the functions for encoding these type hashes, and
 * various data structures shared by the origination controller contracts.
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
    // solhint-disable max-line-length

    /// @notice EIP712 type hash for bundle-based signatures.
    bytes32 public constant _TOKEN_ID_TYPEHASH =
        keccak256(
            "LoanTerms(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,uint256 collateralId,bytes32 affiliateCode,SigProperties sigProperties,uint8 side,address signingCounterparty)SigProperties(uint160 nonce,uint96 maxUses)"
        );

    /// @notice EIP712 type hash for item-based signatures.
    bytes32 public constant _ITEMS_TYPEHASH =
        keccak256(
            "LoanTermsWithItems(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,bytes32 affiliateCode,Predicate[] items,SigProperties sigProperties,uint8 side,address signingCounterparty)Predicate(bytes data,address verifier)SigProperties(uint160 nonce,uint96 maxUses)"
        );

    /// @notice EIP712 type hash for interest rate swap signatures.
    bytes32 public constant _INTEREST_RATE_SWAP_TYPEHASH =
        keccak256(
            "LoanTermsWithCurrencyPair(uint32 interestRate,uint64 durationSecs,address vaultedCurrency,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,uint256 collateralId,bytes32 affiliateCode,SigProperties sigProperties,uint8 side,address signingCounterparty)SigProperties(uint160 nonce,uint96 maxUses)"
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
     * @notice Hashes the signature properties for inclusion in _SIG_PROPERTIES_TYPEHASH.
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
     * @notice Hashes a loan for inclusion in the EIP712 signature.
     *
     * @param terms                         The loan terms.
     * @param sigProperties                 The signature properties.
     * @param side                          The side of the signature.
     * @param signingCounterparty           The address of the signing counterparty.
     *
     * @return loanHash                     The hash of the loan.
     */
    function encodeLoan(
        LoanLibrary.LoanTerms calldata terms,
        IOriginationController.SigProperties calldata sigProperties,
        uint8 side,
        address signingCounterparty
    ) public pure returns (bytes32 loanHash) {
        loanHash = keccak256(
            abi.encode(
                _TOKEN_ID_TYPEHASH,
                terms.interestRate,
                terms.durationSecs,
                terms.collateralAddress,
                terms.deadline,
                terms.payableCurrency,
                terms.principal,
                terms.collateralId,
                terms.affiliateCode,
                encodeSigProperties(sigProperties),
                uint8(side),
                signingCounterparty
            )
        );
    }

    /**
     * @notice Hashes a loan with items for inclusion in the EIP712 signature.
     *
     * @param terms                         The loan terms.
     * @param itemPredicates                The predicate rules for the items in the bundle.
     * @param sigProperties                 The signature properties.
     * @param side                          The side of the signature.
     * @param signingCounterparty           The address of the signing counterparty.
     *
     * @return loanWithItemsHash            The hash of the loan with items.
     */
    function encodeLoanWithItems(
        LoanLibrary.LoanTerms calldata terms,
        LoanLibrary.Predicate[] calldata itemPredicates,
        IOriginationController.SigProperties calldata sigProperties,
        uint8 side,
        address signingCounterparty
    ) public pure returns (bytes32 loanWithItemsHash) {
        loanWithItemsHash = keccak256(
            abi.encode(
                _ITEMS_TYPEHASH,
                terms.interestRate,
                terms.durationSecs,
                terms.collateralAddress,
                terms.deadline,
                terms.payableCurrency,
                terms.principal,
                terms.affiliateCode,
                encodePredicates(itemPredicates),
                encodeSigProperties(sigProperties),
                side,
                signingCounterparty
            )
        );
    }


    /**
     * @notice Hashes a loan with interest rate swap for inclusion in the EIP712 signature.
     *
     * @param terms                         The loan terms.
     * @param sigProperties                 The signature properties.
     * @param vaultedCurrency               The currency to be vaulted.
     * @param side                          The side of the signature.
     * @param signingCounterparty           The address of the signing counterparty.
     *
     * @return loanHash                     The hash of the loan.
     */
    function encodeLoanWithInterestRateSwap(
        LoanLibrary.LoanTerms calldata terms,
        IOriginationController.SigProperties calldata sigProperties,
        address vaultedCurrency,
        uint8 side,
        address signingCounterparty
    ) public pure returns (bytes32 loanHash) {
        loanHash = keccak256(
            abi.encode(
                _INTEREST_RATE_SWAP_TYPEHASH,
                terms.interestRate,
                terms.durationSecs,
                vaultedCurrency,
                terms.collateralAddress,
                terms.deadline,
                terms.payableCurrency,
                terms.principal,
                terms.collateralId,
                terms.affiliateCode,
                encodeSigProperties(sigProperties),
                uint8(side),
                signingCounterparty
            )
        );
    }
}
