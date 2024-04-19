// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
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
    OC_InvalidState,
    OC_SelfApprove,
    OC_ApprovedOwnLoan,
    OC_InvalidSignature,
    OC_CallerNotParticipant,
    OC_SideMismatch,
    OC_RolloverCurrencyMismatch,
    OC_RolloverCollateralMismatch
} from "../errors/Lending.sol";

/**
 * @title OriginationController
 * @author Non-Fungible Technologies, Inc.
 *
 * The Origination Controller is responsible for initiating new loans
 * and rollovers in the Arcade.xyz lending protocol.
 *
 * When a loan is originated, the borrower receives the principal minus
 * fees if any. Before the collateral is escrowed, the borrower can
 * execute a callback function to perform any actions necessary to
 * prepare for the loan. The callback function is optional. After the
 * callback function is executed, the collateral is escrowed in LoanCore.
 * If the borrower chooses not to execute a callback function, the
 * collateral is escrowed in LoanCore immediately.
 *
 * During rollovers, there is no borrower callback functionality. The collateral
 * does not move from escrow in LoanCore. Only the payable currency is transferred
 * where applicable.
 */
contract OriginationController is
    IOriginationController,
    FeeLookups,
    EIP712,
    OriginationCalculator,
    ReentrancyGuard,
    AccessControlEnumerable
{
    using SafeERC20 for IERC20;

    // ============================================ STATE ==============================================

    // =================== Constants =====================

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN");
    bytes32 public constant MIGRATION_MANAGER_ROLE = keccak256("MIGRATION_MANAGER");

    // =============== Contract References ===============

    IOriginationHelpers public immutable originationHelpers;
    ILoanCore public immutable loanCore;
    IFeeController public immutable feeController;

    // ================= Approval State ==================

    /// @notice Mapping from owner to operator approvals
    mapping(address => mapping(address => bool)) private _signerApprovals;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Creates a new origination controller contract, also initializing
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
    ) EIP712("OriginationController", "4") {
        if (_originationHelpers == address(0)) revert OC_ZeroAddress("originationHelpers");
        if (_loanCore == address(0)) revert OC_ZeroAddress("loanCore");
        if (_feeController == address(0)) revert OC_ZeroAddress("feeController");

        _setupRole(ADMIN_ROLE, msg.sender);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);

        _setupRole(MIGRATION_MANAGER_ROLE, msg.sender);
        _setRoleAdmin(MIGRATION_MANAGER_ROLE, ADMIN_ROLE);

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

        loanId = _initialize(loanTerms, borrowerData, lender, neededSide);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationHelpers.runPredicatesCheck(borrowerData.borrower, lender, loanTerms, itemPredicates);
    }

    /**
     * @notice Rollover an existing loan using a signature to originate the new loan.
     *         The lender can be the same lender as the loan to be rolled over,
     *         or a new lender. The net funding between the old and new loan is calculated,
     *         with funds withdrawn from relevant parties.
     *
     * @notice If item predicates are passed, they are used to verify collateral.
     *
     * @param oldLoanId                     The ID of the old loan.
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param lender                        Address of the lender.
     * @param sig                           The loan terms signature, with v, r, s fields and possible extra data.
     * @param sigProperties                 Signature nonce and max uses for this nonce.
     * @param itemPredicates                The predicate rules for the items in the bundle.
     *
     * @return newLoanId                    The unique ID of the new loan.
     */
    function rolloverLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata loanTerms,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) public override returns (uint256 newLoanId) {
        originationHelpers.validateLoanTerms(loanTerms);

        {
            LoanLibrary.LoanData memory data = loanCore.getLoan(oldLoanId);
            if (data.state != LoanLibrary.LoanState.Active) revert OC_InvalidState(data.state);
            _validateRollover(data.terms, loanTerms);
        }

        address borrower = IERC721(loanCore.borrowerNote()).ownerOf(oldLoanId);

        // Determine if signature needs to be on the borrow or lend side
        Side neededSide = isSelfOrApproved(borrower, msg.sender) ? Side.LEND : Side.BORROW;

        address signingCounterparty = neededSide == Side.LEND ? lender : borrower;
        address callingCounterparty = neededSide == Side.LEND ? borrower : lender;

        {
            (bytes32 sighash, address externalSigner) = _recoverSignature(loanTerms, sig, sigProperties, neededSide, signingCounterparty, itemPredicates);

            _validateCounterparties(signingCounterparty, callingCounterparty, msg.sender, externalSigner, sig, sighash);

            loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);
        }

        newLoanId = _rollover(oldLoanId, loanTerms, borrower, lender);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationHelpers.runPredicatesCheck(borrower, lender, loanTerms, itemPredicates);
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
     * @dev Validate the rules for rolling over a loan - must be using the same
     *      currency and collateral.
     *
     * @param oldTerms              The terms of the old loan, fetched from LoanCore.
     * @param newTerms              The terms of the new loan, provided by the caller.
     */
    function _validateRollover(LoanLibrary.LoanTerms memory oldTerms, LoanLibrary.LoanTerms memory newTerms)
        internal
        pure
    {
        if (newTerms.payableCurrency != oldTerms.payableCurrency)
            revert OC_RolloverCurrencyMismatch(oldTerms.payableCurrency, newTerms.payableCurrency);

        if (newTerms.collateralAddress != oldTerms.collateralAddress || newTerms.collateralId != oldTerms.collateralId)
            revert OC_RolloverCollateralMismatch(
                oldTerms.collateralAddress,
                oldTerms.collateralId,
                newTerms.collateralAddress,
                newTerms.collateralId
            );
    }

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
     * @dev Perform loan initialization. Take custody of both principal and
     *      collateral, and tell LoanCore to create and start a loan.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param borrowerData                  Struct containing borrower address and any callback data.
     * @param lender                        Address of the lender.
     * @param neededSide                    The side of the loan the signature will take (lend or borrow).
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function _initialize(
        LoanLibrary.LoanTerms calldata loanTerms,
        BorrowerData calldata borrowerData,
        address lender,
        Side neededSide
    ) internal nonReentrant returns (uint256 loanId) {
        // get fee snapshot from fee controller
        (LoanLibrary.FeeSnapshot memory feeSnapshot) = feeController.getFeeSnapshot();

        // ---------------------- Borrower receives principal ----------------------
        // Collect principal from lender and send to borrower
        IERC20(loanTerms.payableCurrency).safeTransferFrom(lender, borrowerData.borrower, loanTerms.principal);

        // ----------------------- Express borrow callback --------------------------
        // If callback params present and the caller is on the borrow side, call the callback function on the borrower
        if (borrowerData.callbackData.length > 0 && neededSide == Side.LEND) {
            IExpressBorrow(borrowerData.borrower).executeOperation(msg.sender, lender, loanTerms, borrowerData.callbackData);
        }

        // ---------------------- LoanCore collects collateral ----------------------
        // Post-callback: collect collateral from borrower and send to LoanCore
        IERC721(loanTerms.collateralAddress).transferFrom(borrowerData.borrower, address(loanCore), loanTerms.collateralId);

        // Create loan in LoanCore
        loanId = loanCore.startLoan(lender, borrowerData.borrower, loanTerms, feeSnapshot);
    }

    /**
     * @notice Perform loan rollover. Take custody of principal, and tell LoanCore to
     *         roll over the existing loan.
     *
     * @param oldLoanId                     The ID of the loan to be rolled over.
     * @param newTerms                      The terms agreed by the lender and borrower.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function _rollover(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata newTerms,
        address borrower,
        address lender
    ) internal nonReentrant returns (uint256 loanId) {
        LoanLibrary.LoanData memory oldLoanData = loanCore.getLoan(oldLoanId);

        address oldLender = loanCore.lenderNote().ownerOf(oldLoanId);
        IERC20 payableCurrency = IERC20(oldLoanData.terms.payableCurrency);

        // Calculate settle amounts
        OriginationLibrary.RolloverAmounts memory amounts = _calculateRolloverAmounts(
            oldLoanData,
            newTerms.principal,
            lender,
            oldLender
        );

        // Collect funds based on settle amounts and total them
        uint256 settledAmount;
        if (lender != oldLender) {
            // If new lender, take new principal from new lender
            payableCurrency.safeTransferFrom(lender, address(this), amounts.amountFromLender);
            settledAmount += amounts.amountFromLender;
        } else if (amounts.leftoverPrincipal > 0) {
            // If same lender, and new amount from lender is greater than old loan repayment amount,
            // take the difference from the lender
            payableCurrency.safeTransferFrom(lender, address(this), amounts.leftoverPrincipal);
            settledAmount += amounts.leftoverPrincipal;
        }

        if (amounts.needFromBorrower > 0) {
            // Borrower owes from old loan
            payableCurrency.safeTransferFrom(borrower, address(this), amounts.needFromBorrower);
            settledAmount += amounts.needFromBorrower;
        }

        // approve LoanCore to take the total settled amount
        payableCurrency.safeApprove(address(loanCore), settledAmount);

        loanId = loanCore.rollover(
            oldLoanId,
            oldLender,
            borrower,
            lender,
            newTerms,
            settledAmount,
            amounts.amountToOldLender,
            amounts.amountToLender,
            amounts.amountToBorrower,
            amounts.interestAmount
        );
    }
}
