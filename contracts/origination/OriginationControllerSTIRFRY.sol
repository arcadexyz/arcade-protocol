// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./OriginationCalculator.sol";

import "../interfaces/IOriginationController.sol";
import "../interfaces/IOriginationHelpers.sol";
import "../interfaces/ILoanCore.sol";
import "../interfaces/IFeeController.sol";
import "../interfaces/IExpressBorrow.sol";

import "../libraries/OriginationLibrary.sol";
import "../libraries/FeeLookups.sol";
import "../libraries/Constants.sol";

import "../verifiers/ArcadeItemsVerifier.sol";

import {
    OC_ZeroAddress,
    OC_SelfApprove,
    OC_ApprovedOwnLoan,
    OC_InvalidSignature,
    OC_CallerNotParticipant,
    OC_SideMismatch
} from "../errors/Lending.sol";

/**
 * @title OriginationControllerSTIRFRY
 * @author Non-Fungible Technologies, Inc.
 *
 * STIRFRY - Set-Term Interest Rate Fixed Rate Yield
 *
 * This contract is similar to the base OriginationController, with a few key changes:
 * 1). The collateral is collected from the Lender instead of the Borrower.
 * 2). The borrower does not receive any principal at the start of the loan.
 *
 * These two differences, do not define the how the economics of how the loan functions, but are rather a means
 * to an end for facilitating a new type of lending primitive using the existing Arcade protocol.
 *
 * In a STIRFRY loan scenario, a Lender will mint a vault and deposit into the vault an ERC20 that accumulates some
 * sort of variable yield. From the Lender's perspective, they want to de-risk and lock in a fixed rate yield on
 * the ERC20 which is inherently a variable yield ERC20. This is where the Borrower comes in. A borrower will deposit
 * the same ERC20 into the vault that the Lender created. The amount of this ERC20 that the Borrower deposits is
 * equivalent to the fixed rate yield that the Lender is signaling in their signed loan terms. When a Borrower
 * deposits the fixed rate yield amount into the Lender's vault, a loan will be originated. Upon loan origination,
 * the Borrower will not receive any principal. Instead, they are reserving the right to repay the loan at any time
 * and receive the vaulted collateral, which may be worth more than at the time of loan origination due to the
 * variable yield accumulated while the assets are in loan. In instances where the borrower defaults on the loan,
 * the lender will collect the collateral from the loan which includes the fixed rate yield amount the borrower
 * deposited at the start the loan.
 *
 * Due to how OriginationController counterparty signatures work, it is also possible for the borrower to sign the
 * loan terms. In this case, the lender will start the loan, only once the borrower have deposited the fixed rate
 * yield ERC20 amount into the Lender's vault.
 */

contract OriginationControllerSTIRFRY is
    IOriginationController,
    FeeLookups,
    EIP712,
    OriginationCalculator,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    // ============================================ STATE ==============================================

    // =============== Contract References ===============

    IOriginationHelpers public immutable originationHelpers;
    ILoanCore public immutable loanCore;
    IFeeController public immutable feeController;

    // ================= Approval State ==================

    /// @notice Mapping from owner to operator approvals
    mapping(address => mapping(address => bool)) private _signerApprovals;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Creates a new origination controller STIRFRY contract, also initializing
     *         the parent signature verifier.
     *
     * @dev For this controller to work, it needs to be granted the ORIGINATOR_ROLE
     *      in loan core after deployment.
     *
     * @param _originationHelpers     The address of the origination shared storage contract.
     * @param _loanCore                     The address of the loan core logic of the protocol.
     * @param _feeController                The address of the fee logic of the protocol.
     */
    constructor(
        address _originationHelpers,
        address _loanCore,
        address _feeController
    ) EIP712("OriginationControllerSTIRFRY", "1") {
        if (_originationHelpers == address(0)) revert OC_ZeroAddress("originationHelpers");
        if (_loanCore == address(0)) revert OC_ZeroAddress("loanCore");
        if (_feeController == address(0)) revert OC_ZeroAddress("feeController");

        originationHelpers = IOriginationHelpers(_originationHelpers);
        loanCore = ILoanCore(_loanCore);
        feeController = IFeeController(_feeController);
    }

    // ======================================= LOAN ORIGINATION =========================================

    /**
     * @notice Initializes a loan with Loan Core.
     *
     * @notice If item predicates are passed, they are used to verify collateral.
     *
     * @dev The caller must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must come from the opposite side of the loan as the caller.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param borrowerData                  Struct containing borrower address and any callback data.
     * @param lender                        Address of the lender.
     * @param sig                           The loan terms signature, with v, r, s fields, and possible extra data.
     * @param sigProperties                 Signature nonce and max uses for this nonce.
     * @param itemPredicates                The predicate rules for the items in the bundle.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function initializeLoan(
        LoanLibrary.LoanTerms calldata loanTerms,
        BorrowerData calldata borrowerData,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) public override returns (uint256 loanId) {
        originationHelpers.validateLoanTerms(loanTerms);

        // Determine if signature needs to be on the borrow or lend side
        Side neededSide = isSelfOrApproved(borrowerData.borrower, msg.sender) ? Side.LEND : Side.BORROW;

        address signingCounterparty = neededSide == Side.LEND ? lender : borrowerData.borrower;
        address callingCounterparty = neededSide == Side.LEND ? borrowerData.borrower : lender;

        {
            (bytes32 sighash, address externalSigner) = _recoverSignature(loanTerms, sig, sigProperties, neededSide, signingCounterparty, itemPredicates);

            _validateCounterparties(signingCounterparty, callingCounterparty, msg.sender, externalSigner, sig, sighash);

            loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);
        }

        loanId = _initialize(loanTerms, borrowerData, lender);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationHelpers.runPredicatesCheck(borrowerData.borrower, lender, loanTerms, itemPredicates);
    }

    function rolloverLoan(
        uint256,
        LoanLibrary.LoanTerms calldata,
        address,
        Signature calldata,
        SigProperties calldata,
        LoanLibrary.Predicate[] calldata
    ) public override returns (uint256) {
        // NOTE: Rollovers are not supported in STIRFRY.
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

    // =========================================== HELPERS ==============================================

    /**
     * @dev Ensure that one counterparty has signed the loan terms, and the other
     *      has initiated the transaction.
     *
     * @param signingCounterparty       The address of the counterparty who signed the terms.
     * @param callingCounterparty       The address on the other side of the loan as the signingCounterparty.
     * @param caller                    The address initiating the transaction.
     * @param signer                    The address recovered from the loan terms signature.
     * @param sig                       A struct containing the signature data (for checking EIP-1271).
     * @param sighash                   The hash of the signature payload (used for EIP-1271 check).
     */
    // solhint-disable-next-line code-complexity
    function _validateCounterparties(
        address signingCounterparty,
        address callingCounterparty,
        address caller,
        address signer,
        Signature calldata sig,
        bytes32 sighash
    ) internal view {
        // Make sure the signer recovered from the loan terms is not the caller,
        // and even if the caller is approved, the caller is not the signing counterparty
        if (caller == signer || caller == signingCounterparty) revert OC_ApprovedOwnLoan(caller);

        // Check that caller can actually call this function - neededSide assignment
        // defaults to BORROW if the signature is not approved by the borrower, but it could
        // also not be a participant
        if (!isSelfOrApproved(callingCounterparty, caller)) {
            revert OC_CallerNotParticipant(msg.sender);
        }

        // Check signature validity
        if (!isSelfOrApproved(signingCounterparty, signer) && !OriginationLibrary.isApprovedForContract(signingCounterparty, sig, sighash)) {
            revert OC_InvalidSignature(signingCounterparty, signer);
        }

        // Revert if the signer is the calling counterparty
        if (signer == callingCounterparty) revert OC_SideMismatch(signer);
    }

    /**
     * @dev Perform loan initialization. Take custody of collateral, and tell LoanCore
     *      to create and start a loan.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param borrowerData                  Struct containing borrower address and any callback data.
     * @param lender                        Address of the lender.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function _initialize(
        LoanLibrary.LoanTerms calldata loanTerms,
        BorrowerData calldata borrowerData,
        address lender
    ) internal nonReentrant returns (uint256 loanId) {
        // get fee snapshot from fee controller
        (LoanLibrary.FeeSnapshot memory feeSnapshot) = feeController.getFeeSnapshot();

        // ---------------------- Borrower receives principal ----------------------
        // NOTE: Borrower does not receive principal in STIRFRY

        // ----------------------- Express borrow callback --------------------------
        // NOTE: Borrower callback is not supported in STIRFRY

        // ---------------------- LoanCore collects collateral ----------------------
        // collect collateral from lender and send to LoanCore
        IERC721(loanTerms.collateralAddress).transferFrom(lender, address(loanCore), loanTerms.collateralId);

        // Create loan in LoanCore
        loanId = loanCore.startLoan(lender, borrowerData.borrower, loanTerms, feeSnapshot);
    }
}
