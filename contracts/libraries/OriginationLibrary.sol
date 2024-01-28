// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
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
            "LoanTerms(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,uint256 collateralId,bytes32 affiliateCode,uint160 nonce,uint96 maxUses,uint8 side)"
        );

    /// @notice EIP712 type hash for item-based signatures.
    bytes32 public constant _ITEMS_TYPEHASH =
        keccak256(
            // solhint-disable max-line-length
            "LoanTermsWithItems(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,bytes32 affiliateCode,Predicate[] items,uint160 nonce,uint96 maxUses,uint8 side)Predicate(bytes data,address verifier)"
        );

    /// @notice EIP712 type hash for Predicate.
    bytes32 public constant _PREDICATE_TYPEHASH =
        keccak256(
            "Predicate(bytes data,address verifier)"
        );

    // ==================================== ORIGINATION HELPERS =======================================

    /**
     * @dev Calculate the net amounts needed from each party for a rollover or migration - the
     *      borrower, the new lender, and the old lender (can be same as new lender).
     *      Determine the amount to either pay or withdraw from the borrower, and
     *      any payments to be sent to the old lender.
     *
     * @param oldPrincipal          The principal amount of the old loan.
     * @param oldInterestAmount     The interest amount of the old loan.
     * @param newPrincipalAmount    The principal amount of the new loan.
     * @param lender                The address of the new lender.
     * @param oldLender             The address of the old lender.
     * @param borrowerFee           The fee amount to be paid by the borrower.
     * @param lenderFee             The fee amount to be paid by the lender.
     * @param interestFee           The fee amount to be paid by the borrower to the lender.
     *
     * @return amounts              The net amounts owed to each party.
     */
    function rolloverAmounts(
        uint256 oldPrincipal,
        uint256 oldInterestAmount,
        uint256 newPrincipalAmount,
        address lender,
        address oldLender,
        uint256 borrowerFee,
        uint256 lenderFee,
        uint256 interestFee
    ) public pure returns (RolloverAmounts memory amounts) {
        uint256 borrowerOwedForNewLoan = 0;
        if (borrowerFee > 0 || lenderFee > 0 || interestFee > 0) {
            // account for fees if they exist
            unchecked {
                borrowerOwedForNewLoan = newPrincipalAmount - borrowerFee;
                amounts.amountFromLender = newPrincipalAmount + lenderFee + interestFee;
            }
        } else {
            borrowerOwedForNewLoan = newPrincipalAmount;
            amounts.amountFromLender = newPrincipalAmount;
        }

        amounts.interestAmount = oldInterestAmount;
        uint256 repayAmount = oldPrincipal + oldInterestAmount;

        // Calculate net amounts based on if repayment amount for old loan is
        // greater than new loan principal
        if (repayAmount > borrowerOwedForNewLoan) {
            // amount to collect from borrower
            unchecked {
                amounts.needFromBorrower = repayAmount - borrowerOwedForNewLoan;
            }
        } else {
            // amount to collect from lender (either old or new)
            amounts.leftoverPrincipal = amounts.amountFromLender - repayAmount;

            // amount to send to borrower
            unchecked {
                amounts.amountToBorrower = borrowerOwedForNewLoan - repayAmount;
            }
        }

        // Calculate lender amounts based on if the lender is the same as the old lender
        if (lender != oldLender) {
            // different lenders, repay old lender
            amounts.amountToOldLender = repayAmount;

            // different lender, new lender is owed zero tokens
            amounts.amountToLender = 0;
        } else {
            // same lender
            amounts.amountToOldLender = 0;

            // same lender, so check if the amount to collect from the lender is less than
            // the amount the lender is owed for the old loan. If so, the lender is owed the
            // difference
            if (amounts.needFromBorrower > 0 && repayAmount > amounts.amountFromLender) {
                unchecked {
                    amounts.amountToLender = repayAmount - amounts.amountFromLender;
                }
            }
        }
    }

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
    function _encodePredicates(LoanLibrary.Predicate[] memory predicates) public pure returns (bytes32 itemsHash) {
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
        return (success && result.length == 32 && abi.decode(result, (bytes4)) == IERC1271.isValidSignature.selector);
    }
}