// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./OriginationCalculator.sol";

import "../interfaces/IOriginationHelpers.sol";
import "../interfaces/ILoanCore.sol";

import "../libraries/OriginationLibrary.sol";

import { OC_ZeroAddress, OC_SelfApprove } from "../errors/Lending.sol";

/**
 * @title OriginationControllerBase
 * @author Non-Fungible Technologies, Inc.
 *
 * The Origination Controller Base contract provides common functionality for all
 * origination controllers, including signature verification, share reference
 * contracts, approved third party originators, and rollover calculation helpers.
 */
abstract contract OriginationControllerBase is IOriginationControllerBase, EIP712, OriginationCalculator {
    // ============================================ STATE ==============================================
    // =============== Contract References ===============

    IOriginationHelpers public immutable originationHelpers;
    ILoanCore public immutable loanCore;

    // ================= Approval State ==================

    /// @notice Mapping from owner to operator approvals
    mapping(address => mapping(address => bool)) private _signerApprovals;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Creates a base origination controller containing shared functionality for origination
     *         controller contracts, also initializing the parent signature verifier.
     *
     * @param _originationHelpers           The address of the origination shared storage contract.
     * @param _loanCore                     The address of the loan core logic of the protocol.
     */
    constructor(
        address _originationHelpers,
        address _loanCore
    ) EIP712("OriginationController", "4") {
        if (_originationHelpers == address(0)) revert OC_ZeroAddress("originationHelpers");
        if (_loanCore == address(0)) revert OC_ZeroAddress("loanCore");

        originationHelpers = IOriginationHelpers(_originationHelpers);
        loanCore = ILoanCore(_loanCore);
    }

    // ==================================== PERMISSION MANAGEMENT =======================================

    /**
     * @notice Approve a third party to sign or initialize loans on a counterparty's behalf.
     * @notice Useful to multisig counterparties (who cannot sign themselves) or third-party integrations.
     *
     * @param signer                        The party to set approval for.
     * @param approved                      Whether the party should be approved.
     */
    function approve(address signer, bool approved) public override {
        if (signer == msg.sender) revert OC_SelfApprove(msg.sender);

        _signerApprovals[msg.sender][signer] = approved;

        emit Approval(msg.sender, signer, approved);
    }

    /**
     * @notice Reports whether a party is approved to act on a counterparty's behalf.
     *
     * @param owner                         The grantor of permission.
     * @param signer                        The grantee of permission.
     *
     * @return isApproved                   Whether the grantee has been approved by the grantor.
     */
    function isApproved(address owner, address signer) public view override returns (bool) {
        return _signerApprovals[owner][signer];
    }

    /**
     * @notice Reports whether the signer matches the target or is approved by the target.
     *
     * @param target                        The grantor of permission.
     * @param signer                        The grantee of permission.
     *
     * @return isSelfOrApproved             Whether the signer is either the grantor themselves, or approved.
     */
    function isSelfOrApproved(address target, address signer) public view override returns (bool) {
        return target == signer || isApproved(target, signer);
    }

    // ==================================== SIGNATURE VERIFICATION ======================================

    /**
     * @notice Determine the external signer for a signature specifying only a collateral address and ID.
     *
     * @param loanTerms                     The terms of the loan.
     * @param sig                           The signature, with v, r, s fields.
     * @param sigProperties                 Signature nonce and max uses for this nonce.
     * @param side                          The side of the loan being signed.
     * @param signingCounterparty           The address of the counterparty who signed the terms.
     *
     * @return sighash                      The hash that was signed.
     * @return signer                       The address of the recovered signer.
     */
    function recoverTokenSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        Side side,
        address signingCounterparty
    ) public view override returns (bytes32 sighash, address signer) {
        bytes32 loanHash = OriginationLibrary.encodeLoan(
            loanTerms,
            sigProperties,
            uint8(side),
            signingCounterparty
        );

        sighash = _hashTypedDataV4(loanHash);
        signer = ECDSA.recover(sighash, sig.v, sig.r, sig.s);
    }

    /**
     * @notice Determine the external signer for a signature specifying specific items.
     * @dev    Bundle ID should _not_ be included in this signature, because the loan
     *         can be initiated with any arbitrary bundle - as long as the bundle contains the items.
     *
     * @param loanTerms                     The terms of the loan.
     * @param sig                           The loan terms signature, with v, r, s fields.
     * @param itemPredicates                The predicate rules for the items in the bundle.
     * @param sigProperties                 Signature nonce and max uses for this nonce.
     * @param side                          The side of the loan being signed.
     * @param signingCounterparty           The address of the counterparty who signed the terms.
     *
     * @return sighash                      The hash that was signed.
     * @return signer                       The address of the recovered signer.
     */
    function recoverItemsSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        LoanLibrary.Predicate[] calldata itemPredicates,
        SigProperties calldata sigProperties,
        Side side,
        address signingCounterparty
    ) public view override returns (bytes32 sighash, address signer) {
        bytes32 loanHash = OriginationLibrary.encodeLoanWithItems(
            loanTerms,
            itemPredicates,
            sigProperties,
            uint8(side),
            signingCounterparty
        );

        sighash = _hashTypedDataV4(loanHash);
        signer = ECDSA.recover(sighash, sig.v, sig.r, sig.s);
    }

    // ============================================ HELPER ==============================================

    /**
     * @notice Determine the sighash and external signer given the loan terms, signature, nonce,
     *         and side the expected signer is on. If item predicates are passed, item-based signature
     *         recovery is used.
     *
     * @param loanTerms                     The terms of the loan to be started.
     * @param sig                           The signature, with v, r, s fields.
     * @param sigProperties                 Signature nonce and max uses for this nonce.
     * @param neededSide                    The side of the loan the signature will take (lend or borrow).
     * @param signingCounterparty           The address of the counterparty who signed the terms.
     * @param itemPredicates                The predicate rules for the items in the bundle.
     *
     * @return sighash                      The hash that was signed.
     * @return externalSigner               The address of the recovered signer.
     */
    function _recoverSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        Side neededSide,
        address signingCounterparty,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) public view returns (bytes32 sighash, address externalSigner) {
        if (itemPredicates.length > 0) {
            (sighash, externalSigner) = recoverItemsSignature(
                loanTerms,
                sig,
                itemPredicates,
                sigProperties,
                neededSide,
                signingCounterparty
            );
        } else {
            (sighash, externalSigner) = recoverTokenSignature(
                loanTerms,
                sig,
                sigProperties,
                neededSide,
                signingCounterparty
            );
        }
    }
}
