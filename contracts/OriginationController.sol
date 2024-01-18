// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./interfaces/IOriginationController.sol";
import "./interfaces/ILoanCore.sol";
import "./interfaces/IERC721Permit.sol";
import "./interfaces/ISignatureVerifier.sol";
import "./interfaces/IFeeController.sol";
import "./interfaces/IExpressBorrow.sol";

import "./libraries/InterestCalculator.sol";
import "./libraries/FeeLookups.sol";

import "./verifiers/ArcadeItemsVerifier.sol";

import "./v3/interfaces/ILoanCoreV3.sol";
import "./v3/interfaces/IOriginationControllerV3.sol";
import "./v3/interfaces/IRepaymentControllerV3.sol";
import "./v3/libraries/LoanLibraryV3.sol";

import {
    OC_ZeroAddress,
    OC_InvalidState,
    OC_InvalidVerifier,
    OC_BatchLengthMismatch,
    OC_PredicateFailed,
    OC_SelfApprove,
    OC_ApprovedOwnLoan,
    OC_InvalidSignature,
    OC_CallerNotParticipant,
    OC_SideMismatch,
    OC_PrincipalTooLow,
    OC_LoanDuration,
    OC_InterestRate,
    OC_SignatureIsExpired,
    OC_RolloverCurrencyMismatch,
    OC_RolloverCollateralMismatch,
    OC_InvalidCurrency,
    OC_InvalidCollateral,
    OC_ZeroArrayElements,
    OC_ArrayTooManyElements,
    OC_InvalidState,
    OC_InvalidStateMigration
} from "./errors/Lending.sol";

/**
 * @title OriginationController
 * @author Non-Fungible Technologies, Inc.
 *
 * The Origination Controller is the entry point for all new loans
 * in the Arcade.xyz lending protocol. This contract has the exclusive
 * responsibility of creating new loans in LoanCore. All permissioning,
 * signature verification, and collateral verification takes place in
 * this contract.
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
    InterestCalculator,
    FeeLookups,
    EIP712,
    ReentrancyGuard,
    AccessControlEnumerable
{
    using SafeERC20 for IERC20;

    // ============================================ STATE ==============================================

    // =================== Constants =====================

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN");
    bytes32 public constant WHITELIST_MANAGER_ROLE = keccak256("WHITELIST_MANAGER");

    /// @notice EIP712 type hash for bundle-based signatures.
    bytes32 private constant _TOKEN_ID_TYPEHASH =
        keccak256(
            // solhint-disable-next-line max-line-length
            "LoanTerms(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,uint256 collateralId,bytes32 affiliateCode,uint160 nonce,uint96 maxUses,uint8 side)"
        );

    /// @notice EIP712 type hash for item-based signatures.
    bytes32 private constant _ITEMS_TYPEHASH =
        keccak256(
            // solhint-disable max-line-length
            "LoanTermsWithItems(uint32 interestRate,uint64 durationSecs,address collateralAddress,uint96 deadline,address payableCurrency,uint256 principal,bytes32 affiliateCode,Predicate[] items,uint160 nonce,uint96 maxUses,uint8 side)Predicate(bytes data,address verifier)"
        );

    /// @notice EIP712 type hash for Predicate.
    bytes32 public constant _PREDICATE_TYPEHASH =
        keccak256(
            "Predicate(bytes data,address verifier)"
        );

    // =============== Contract References ===============

    ILoanCore private immutable loanCore;
    IFeeController private immutable feeController;

    ILoanCoreV3 private immutable loanCoreV3;
    IOriginationControllerV3 private immutable originationControllerV3;
    IRepaymentControllerV3 private immutable repaymentControllerV3;

    // ================= Approval State ==================

    /// @notice Mapping from owner to operator approvals
    mapping(address => mapping(address => bool)) private _signerApprovals;
    /// @notice Mapping from address to whether that verifier contract has been whitelisted
    mapping(address => bool) public allowedVerifiers;
    /// @notice Mapping from ERC20 token address to boolean indicating allowed payable currencies and set minimums
    mapping(address => Currency) public allowedCurrencies;
    /// @notice Mapping from ERC721 or ERC1155 token address to boolean indicating allowed collateral types
    mapping(address => bool) public allowedCollateral;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Creates a new origination controller contract, also initializing
     *         the parent signature verifier.
     *
     * @dev For this controller to work, it needs to be granted the ORIGINATOR_ROLE
     *      in loan core after deployment.
     *
     * @param _loanCore                     The address of the loan core logic of the protocol.
     * @param _feeController                The address of the fee logic of the protocol.
     */
    constructor(
        address _loanCore,
        address _feeController,
        address _loanCoreV3,
        address _originationControllerV3,
        address _repaymentControllerV3
    ) EIP712("OriginationController", "4") {
        if (_loanCore == address(0)) revert OC_ZeroAddress("loanCore");
        if (_feeController == address(0)) revert OC_ZeroAddress("feeController");
        if (_loanCoreV3 == address(0)) revert OC_ZeroAddress("loanCoreV3");
        if (_originationControllerV3 == address(0)) revert OC_ZeroAddress("originationControllerV3");
        if (_repaymentControllerV3 == address(0)) revert OC_ZeroAddress("repaymentControllerV3");

        _setupRole(ADMIN_ROLE, msg.sender);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);

        _setupRole(WHITELIST_MANAGER_ROLE, msg.sender);
        _setRoleAdmin(WHITELIST_MANAGER_ROLE, ADMIN_ROLE);

        loanCore = ILoanCore(_loanCore);
        feeController = IFeeController(_feeController);

        loanCoreV3 = ILoanCoreV3(_loanCoreV3);
        originationControllerV3 = IOriginationControllerV3(_originationControllerV3);
        repaymentControllerV3 = IRepaymentControllerV3(_repaymentControllerV3);
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
        _validateLoanTerms(loanTerms);

        // Determine if signature needs to be on the borrow or lend side
        Side neededSide = isSelfOrApproved(borrowerData.borrower, msg.sender) ? Side.LEND : Side.BORROW;

        (bytes32 sighash, address externalSigner) = _recoverSignature(loanTerms, sig, sigProperties, neededSide, itemPredicates);

        _validateCounterparties(borrowerData.borrower, lender, msg.sender, externalSigner, sig, sighash, neededSide);

        loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);
        loanId = _initialize(loanTerms, borrowerData, lender);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) _runPredicatesCheck(borrowerData.borrower, lender, loanTerms, itemPredicates);
    }

    /**
     * @notice Initializes a loan with Loan Core, with a permit signature instead of pre-approved collateral.
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
     * @param collateralSig                 The collateral permit signature, with v, r, s fields.
     * @param permitDeadline                The last timestamp for which the permit signature is valid.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function initializeLoanWithPermit(
        LoanLibrary.LoanTerms calldata loanTerms,
        BorrowerData calldata borrowerData,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates,
        Signature calldata collateralSig,
        uint256 permitDeadline
    ) external override returns (uint256 loanId) {
        IERC721Permit(loanTerms.collateralAddress).permit(
            borrowerData.borrower,
            address(this),
            loanTerms.collateralId,
            permitDeadline,
            collateralSig.v,
            collateralSig.r,
            collateralSig.s
        );

        loanId = initializeLoan(
            loanTerms,
            borrowerData,
            lender,
            sig,
            sigProperties,
            itemPredicates
        );
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
        _validateLoanTerms(loanTerms);

        LoanLibrary.LoanData memory data = loanCore.getLoan(oldLoanId);
        if (data.state != LoanLibrary.LoanState.Active) revert OC_InvalidState(data.state);
        _validateRollover(data.terms, loanTerms);

        address borrower = IERC721(loanCore.borrowerNote()).ownerOf(oldLoanId);

        // Determine if signature needs to be on the borrow or lend side
        Side neededSide = isSelfOrApproved(borrower, msg.sender) ? Side.LEND : Side.BORROW;

        (bytes32 sighash, address externalSigner) = _recoverSignature(loanTerms, sig, sigProperties, neededSide, itemPredicates);

        _validateCounterparties(borrower, lender, msg.sender, externalSigner, sig, sighash, neededSide);

        loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);

        newLoanId = _rollover(oldLoanId, loanTerms, borrower, lender);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) _runPredicatesCheck(borrower, lender, loanTerms, itemPredicates);
    }

    // ======================================= V3 MIGRATION =============================================

    function migrateV3Loan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata newTerms,
        address lender,
        Signature calldata sig,
        uint160 nonce,
        // add maxUses param!
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external override returns (uint256 newLoanId) {
        //////////////////////////////// Loan Validation ////////////////////////////////
        _validateLoanTerms(newTerms);

        LoanLibraryV3.LoanData memory oldLoanData = loanCoreV3.getLoan(oldLoanId);
        if (oldLoanData.state != LoanLibraryV3.LoanState.Active) revert OC_InvalidStateMigration(oldLoanData.state);
        _validateMigration(oldLoanData.terms, newTerms);

        address borrower = IERC721(loanCoreV3.borrowerNote()).ownerOf(oldLoanId);

        // Determine if signature needs to be on the borrow or lend side
        Side neededSide = isSelfOrApproved(borrower, msg.sender) ? Side.LEND : Side.BORROW;

        (bytes32 sighash, address externalSigner) = _recoverSignature(newTerms, sig, nonce, neededSide, itemPredicates);

        _validateCounterparties(borrower, lender, msg.sender, externalSigner, sig, sighash, neededSide);

        //////////////////////////////// Collect V3 BorrowerNote ////////////////////////////////
        IERC721(loanCoreV3.borrowerNote()).safeTransferFrom(borrower, address(this), oldLoanId);

        //////////////////////////////// Start V4 Loan (Begin) ////////////////////////////////
        loanCore.consumeNonce(externalSigner, nonce);

        //////////////////////////////// Repay V3 loan ////////////////////////////////
        // calculate and distribute settled amounts
        (uint256 settledAmount, IERC20 payableCurrency) = _migrate(
            oldLoanId,
            oldLoanData,
            newTerms,
            borrower,
            lender
        );

        // approve LoanCoreV3 to take the total settled amount
        payableCurrency.safeApprove(address(loanCoreV3), settledAmount);
        repaymentControllerV3.repay(oldLoanId);

        // this contract now holds collateral

        //////////////////////////////// Start V4 Loan (Finish) ////////////////////////////////
        // transfer collateral to LoanCore
        IERC721(newTerms.collateralAddress).transferFrom(address(this), address(loanCore), newTerms.collateralId);

        // get lending fees from fee controller and create LoanLibrary.FeeSnapshot from feeData
        IFeeController.FeesOrigination memory feeData = feeController.getFeesOrigination();
        LoanLibrary.FeeSnapshot memory feeSnapshot = LoanLibrary.FeeSnapshot({
            lenderDefaultFee: feeData.lenderDefaultFee,
            lenderInterestFee: feeData.lenderInterestFee,
            lenderPrincipalFee: feeData.lenderPrincipalFee
        });

        // create loan in LoanCore
        newLoanId = loanCore.startLoan(lender, borrower, newTerms, newTerms.principal, newTerms.principal, feeSnapshot);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) _runPredicatesCheck(borrower, lender, newTerms, itemPredicates);
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
    function isApproved(address owner, address signer) public view virtual override returns (bool) {
        return _signerApprovals[owner][signer];
    }

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
        Signature memory sig,
        bytes32 sighash
    ) public view override returns (bool) {
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
     *
     * @return sighash                      The hash that was signed.
     * @return signer                       The address of the recovered signer.
     */
    function recoverTokenSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        Side side
    ) public view override returns (bytes32 sighash, address signer) {
        bytes32 loanHash = keccak256(
            abi.encode(
                _TOKEN_ID_TYPEHASH,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                loanTerms.collateralAddress,
                loanTerms.deadline,
                loanTerms.payableCurrency,
                loanTerms.principal,
                loanTerms.collateralId,
                loanTerms.affiliateCode,
                sigProperties.nonce,
                sigProperties.maxUses,
                uint8(side)
            )
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
     * @param sigProperties                 Signature nonce and max uses for this nonce.
     * @param side                          The side of the loan being signed.
     * @param itemsHash                     The required items in the specified bundle.
     *
     * @return sighash                      The hash that was signed.
     * @return signer                       The address of the recovered signer.
     */
    function recoverItemsSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        Side side,
        bytes32 itemsHash
    ) public view override returns (bytes32 sighash, address signer) {
        bytes32 loanHash = keccak256(
            abi.encode(
                _ITEMS_TYPEHASH,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                loanTerms.collateralAddress,
                loanTerms.deadline,
                loanTerms.payableCurrency,
                loanTerms.principal,
                loanTerms.affiliateCode,
                itemsHash,
                sigProperties.nonce,
                sigProperties.maxUses,
                uint8(side)
            )
        );

        sighash = _hashTypedDataV4(loanHash);
        signer = ECDSA.recover(sighash, sig.v, sig.r, sig.s);
    }

    // ===================================== WHITELIST MANAGER UTILS =====================================

    /**
     * @notice Adds an array of payable currencies to the allowed currencies mapping.
     *
     * @dev Only callable by the whitelist manager role. Entire transaction reverts if one of the
     *      addresses is the zero address. The array of addresses passed to this
     *      function is limited to 50 elements.
     *
     * @param tokens                     Array of token addresses to add.
     * @param currencyData               Whether the token is allowed or not, and the minimum loan size.
     */
    function setAllowedPayableCurrencies(
        address[] calldata tokens,
        Currency[] calldata currencyData
    ) external override onlyRole(WHITELIST_MANAGER_ROLE) {
        if (tokens.length == 0) revert OC_ZeroArrayElements();
        if (tokens.length > 50) revert OC_ArrayTooManyElements();
        if (tokens.length != currencyData.length) revert OC_BatchLengthMismatch();

        for (uint256 i = 0; i < tokens.length;) {
            if (tokens[i] == address(0)) revert OC_ZeroAddress("token");

            allowedCurrencies[tokens[i]] = currencyData[i];
            emit SetAllowedCurrency(tokens[i], currencyData[i].isAllowed, currencyData[i].minPrincipal);

            // Can never overflow because length is bounded by 50
            unchecked {
                i++;
            }
        }
    }

    /**
     * @notice Return whether the address can be used as a loan funding currency.
     *
     * @param token                 The token to query.
     *
     * @return isAllowed            Whether the contract is verified.
     */
    function isAllowedCurrency(address token) public view override returns (bool) {
        return allowedCurrencies[token].isAllowed;
    }

    /**
     * @notice Adds an array collateral tokens to the allowed collateral mapping.
     *
     * @dev Only callable by the whitelist manager role. Entire transaction reverts if one of the
     *      addresses is the zero address. The array of addresses passed to this
     *      function is limited to 50 elements.
     *
     * @param tokens                     Array of token addresses to add.
     * @param isAllowed                  Whether the token is allowed or not.
     */
    function setAllowedCollateralAddresses(
        address[] calldata tokens,
        bool[] calldata isAllowed
    ) external override onlyRole(WHITELIST_MANAGER_ROLE) {
        if (tokens.length == 0) revert OC_ZeroArrayElements();
        if (tokens.length > 50) revert OC_ArrayTooManyElements();
        if (tokens.length != isAllowed.length) revert OC_BatchLengthMismatch();

        for (uint256 i = 0; i < tokens.length;) {
            if (tokens[i] == address(0)) revert OC_ZeroAddress("token");

            allowedCollateral[tokens[i]] = isAllowed[i];
            emit SetAllowedCollateral(tokens[i], isAllowed[i]);

            // Can never overflow because length is bounded by 50
            unchecked {
                i++;
            }
        }
    }

    /**
     * @notice Return whether the address can be used as collateral.
     *
     * @param token                The token to query.
     *
     * @return isAllowed           Whether the token can be used as collateral.
     */
    function isAllowedCollateral(address token) public view override returns (bool) {
        return allowedCollateral[token];
    }

    /**
     * @notice Batch update for verification whitelist, in case of multiple verifiers
     *         active in production.
     *
     * @param verifiers             The list of specified verifier contracts, should implement ISignatureVerifier.
     * @param isAllowed             Whether the specified contracts should be allowed, respectively.
     */
    function setAllowedVerifiers(
        address[] calldata verifiers,
        bool[] calldata isAllowed
    ) external override onlyRole(WHITELIST_MANAGER_ROLE) {
        if (verifiers.length == 0) revert OC_ZeroArrayElements();
        if (verifiers.length > 50) revert OC_ArrayTooManyElements();
        if (verifiers.length != isAllowed.length) revert OC_BatchLengthMismatch();

        for (uint256 i = 0; i < verifiers.length;) {
            if (verifiers[i] == address(0)) revert OC_ZeroAddress("verifier");

            allowedVerifiers[verifiers[i]] = isAllowed[i];
            emit SetAllowedVerifier(verifiers[i], isAllowed[i]);

            // Can never overflow because length is bounded by 50
            unchecked {
                i++;
            }
        }
    }

    /**
     * @notice Return whether the address can be used as a verifier.
     *
     * @param verifier             The verifier contract to query.
     *
     * @return isVerified          Whether the contract is verified.
     */
    function isAllowedVerifier(address verifier) public view override returns (bool) {
        return allowedVerifiers[verifier];
    }

    // =========================================== HELPERS ==============================================

    /**
     * @dev Validates argument bounds for the loan terms.
     *
     * @param terms                  The terms of the loan.
     */
    // solhint-disable-next-line code-complexity
    function _validateLoanTerms(LoanLibrary.LoanTerms memory terms) internal virtual view {
        // validate payable currency
        if (!allowedCurrencies[terms.payableCurrency].isAllowed) revert OC_InvalidCurrency(terms.payableCurrency);

        // principal must be greater than or equal to the configured minimum
        if (terms.principal < allowedCurrencies[terms.payableCurrency].minPrincipal) revert OC_PrincipalTooLow(terms.principal);

        // loan duration must be greater or equal to 1 hr and less or equal to 3 years
        if (terms.durationSecs < 3600 || terms.durationSecs > 94_608_000) revert OC_LoanDuration(terms.durationSecs);

        // interest rate must be greater than or equal to 0.01% and less or equal to 1,000,000%
        if (terms.interestRate < 1 || terms.interestRate > 1e8) revert OC_InterestRate(terms.interestRate);

        // signature must not have already expired
        if (terms.deadline < block.timestamp) revert OC_SignatureIsExpired(terms.deadline);

        // validate collateral
        if (!allowedCollateral[terms.collateralAddress]) revert OC_InvalidCollateral(terms.collateralAddress);
    }

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

    function _validateMigration(LoanLibraryV3.LoanTerms memory oldTerms, LoanLibrary.LoanTerms memory newTerms)
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
     * @param borrower                  The specified borrower for the loan.
     * @param lender                    The specified lender for the loan.
     * @param caller                    The address initiating the transaction.
     * @param signer                    The address recovered from the loan terms signature.
     * @param sig                       A struct containing the signature data (for checking EIP-1271).
     * @param sighash                   The hash of the signature payload (used for EIP-1271 check).
     * @param neededSide                The side of the loan the signature will take (lend or borrow).
     */
    // solhint-disable-next-line code-complexity
    function _validateCounterparties(
        address borrower,
        address lender,
        address caller,
        address signer,
        Signature calldata sig,
        bytes32 sighash,
        Side neededSide
    ) internal view {
        address signingCounterparty = neededSide == Side.LEND ? lender : borrower;
        address callingCounterparty = neededSide == Side.LEND ? borrower : lender;

        // Make sure the signer recovered from the loan terms is not the caller,
        // and even if the caller is approved, the caller is not the signing counterparty
        if (caller == signer || caller == signingCounterparty) revert OC_ApprovedOwnLoan(caller);

        // Check that caller can actually call this function - neededSide assignment
        // defaults to BORROW if the signature is not approved by the borrower, but it could
        // also not be a participant
        if (!isSelfOrApproved(callingCounterparty, caller) && !isApprovedForContract(callingCounterparty, sig, sighash)) {
            revert OC_CallerNotParticipant(msg.sender);
        }

        // Check signature validity
        if (!isSelfOrApproved(signingCounterparty, signer) && !isApprovedForContract(signingCounterparty, sig, sighash)) {
            revert OC_InvalidSignature(signingCounterparty, signer);
        }

        // Revert if the signer is the calling counterparty
        if (signer == callingCounterparty) revert OC_SideMismatch(signer);
    }

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

    /**
     * @dev Run the predicates check for an items signature, sending the defined
     *      predicate payload to each defined verifier contract, and reverting
     *      if a verifier returns false.
     *
     * @param borrower              The borrower of the loan.
     * @param lender                The lender of the loan.
     * @param loanTerms             The terms of the loan.
     * @param itemPredicates        The array of predicates to check.
     */
    function _runPredicatesCheck(
        address borrower,
        address lender,
        LoanLibrary.LoanTerms memory loanTerms,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) internal view {
        for (uint256 i = 0; i < itemPredicates.length;) {
            // Verify items are held in the wrapper
            address verifier = itemPredicates[i].verifier;
            if (!isAllowedVerifier(verifier)) revert OC_InvalidVerifier(verifier);

            if (!ISignatureVerifier(verifier).verifyPredicates(
                borrower,
                lender,
                loanTerms.collateralAddress,
                loanTerms.collateralId,
                itemPredicates[i].data
            )) {
                revert OC_PredicateFailed(
                    verifier,
                    borrower,
                    lender,
                    loanTerms.collateralAddress,
                    loanTerms.collateralId,
                    itemPredicates[i].data
                );
            }

            // Predicates is calldata, overflow is impossible bc of calldata
            // size limits vis-a-vis gas
            unchecked {
                i++;
            }
        }
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
        LoanLibrary.Predicate[] calldata itemPredicates
    ) internal view returns (bytes32 sighash, address externalSigner) {
        if (itemPredicates.length > 0) {
            // If predicates are specified, use the item-based signature
            bytes32 encodedPredicates = _encodePredicates(itemPredicates);

            (sighash, externalSigner) = recoverItemsSignature(
                loanTerms,
                sig,
                sigProperties,
                neededSide,
                encodedPredicates
            );
        } else {
            (sighash, externalSigner) = recoverTokenSignature(
                loanTerms,
                sig,
                sigProperties,
                neededSide
            );
        }
    }

    /**
     * @dev Perform loan initialization. Take custody of both principal and
     *      collateral, and tell LoanCore to create and start a loan.
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
        // get lending origination fees from fee controller
        IFeeController.FeesOrigination memory feeData = feeController.getFeesOrigination();

        // create LoanLibrary.FeeSnapshot struct from feeData
        LoanLibrary.FeeSnapshot memory feeSnapshot = LoanLibrary.FeeSnapshot({
            lenderDefaultFee: feeData.lenderDefaultFee,
            lenderInterestFee: feeData.lenderInterestFee,
            lenderPrincipalFee: feeData.lenderPrincipalFee
        });

        uint256 borrowerFee = (loanTerms.principal * feeData.borrowerOriginationFee) / BASIS_POINTS_DENOMINATOR;
        uint256 lenderFee = (loanTerms.principal * feeData.lenderOriginationFee) / BASIS_POINTS_DENOMINATOR;

        // Determine settlement amounts based on fees
        uint256 amountFromLender = loanTerms.principal + lenderFee;
        uint256 amountToBorrower = loanTerms.principal - borrowerFee;

        // ---------------------- Borrower receives principal ----------------------
        // Collect funds from lender and send to borrower minus fees
        IERC20(loanTerms.payableCurrency).safeTransferFrom(lender, address(this), amountFromLender);
        // send principal to borrower
        IERC20(loanTerms.payableCurrency).safeTransfer(borrowerData.borrower, amountToBorrower);

        // ----------------------- Express borrow callback --------------------------
        // If callback params present, call the callback function on the borrower
        if (borrowerData.callbackData.length > 0) {
            IExpressBorrow(borrowerData.borrower).executeOperation(msg.sender, lender, loanTerms, borrowerFee, borrowerData.callbackData);
        }

        // ---------------------- LoanCore collects collateral ----------------------
        // Post-callback: collect collateral from borrower and send to LoanCore
        IERC721(loanTerms.collateralAddress).transferFrom(borrowerData.borrower, address(loanCore), loanTerms.collateralId);

        // ------------------------ Send fees to LoanCore ---------------------------
        // Send fees to LoanCore
        IERC20(loanTerms.payableCurrency).safeTransfer(address(loanCore), borrowerFee + lenderFee);

        // Create loan in LoanCore
        loanId = loanCore.startLoan(lender, borrowerData.borrower, loanTerms, amountFromLender, amountToBorrower, feeSnapshot);
    }

    /**
     * @dev Perform loan rollover. Take custody of both principal and
     *      collateral, and tell LoanCore to roll over the existing loan.
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
        RolloverAmounts memory amounts = _calculateRolloverAmounts(
            oldLoanData,
            newTerms,
            lender,
            oldLender
        );

        // Collect funds based on settle amounts and total them
        uint256 settledAmount;
        if (lender != oldLender) {
            // If new lender, take new principal from new lender
            payableCurrency.safeTransferFrom(lender, address(this), amounts.amountFromLender);
            settledAmount += amounts.amountFromLender;
        }

        if (amounts.needFromBorrower > 0) {
            // Borrower owes from old loan
            payableCurrency.safeTransferFrom(borrower, address(this), amounts.needFromBorrower);
            settledAmount += amounts.needFromBorrower;
        } else if (amounts.leftoverPrincipal > 0 && lender == oldLender) {
            // If same lender, and new amount from lender is greater than old loan repayment amount,
            // take the difference from the lender
            payableCurrency.safeTransferFrom(lender, address(this), amounts.leftoverPrincipal);
            settledAmount += amounts.leftoverPrincipal;
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

    /**
     * @dev Calculate the net amounts needed for the rollover from each party - the
     *      borrower, the new lender, and the old lender (can be same as new lender).
     *      Determine the amount to either pay or withdraw from the borrower, and
     *      any payments to be sent to the old lender.
     *
     * @param oldLoanData           The loan data struct for the old loan.
     * @param newTerms              The terms struct for the new loan.
     * @param lender                The lender for the new loan.
     * @param oldLender             The lender for the existing loan.
     *
     * @return amounts              The net amounts owed to each party.
     */
    function _calculateRolloverAmounts(
        LoanLibrary.LoanData memory oldLoanData,
        LoanLibrary.LoanTerms calldata newTerms,
        address lender,
        address oldLender
    ) internal view returns (RolloverAmounts memory amounts) {
        // get rollover fees
        IFeeController.FeesRollover memory feeData = feeController.getFeesRollover();

        // Calculate prorated interest amount for old loan
        uint256 interest = getProratedInterestAmount(
            oldLoanData.balance,
            oldLoanData.terms.interestRate,
            oldLoanData.terms.durationSecs,
            uint64(oldLoanData.startDate),
            uint64(oldLoanData.lastAccrualTimestamp),
            block.timestamp
        );
        amounts.interestAmount = interest;
        uint256 repayAmount = oldLoanData.terms.principal + interest;

        // Calculate amount to be sent to borrower for new loan minus rollover fees
        uint256 borrowerFee = (newTerms.principal * feeData.borrowerRolloverFee) / BASIS_POINTS_DENOMINATOR;
        uint256 borrowerOwedForNewLoan = newTerms.principal - borrowerFee;

        // Calculate amount to be collected from the lender for new loan plus rollover fees
        uint256 interestFee = (interest * oldLoanData.feeSnapshot.lenderInterestFee) / BASIS_POINTS_DENOMINATOR;
        uint256 lenderFee = (newTerms.principal * feeData.lenderRolloverFee) / BASIS_POINTS_DENOMINATOR;
        amounts.amountFromLender = newTerms.principal + lenderFee + interestFee;

        // Calculate net amounts based on if repayment amount for old loan is greater than
        // new loan principal minus fees
        if (repayAmount > borrowerOwedForNewLoan) {
            // amount to collect from borrower
            // new loan principal is less than old loan repayment amount
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

    function _migrate(
        uint256 oldLoanId,
        LoanLibraryV3.LoanData memory oldLoanData,
        LoanLibrary.LoanTerms calldata newTerms,
        address borrower,
        address lender
    ) internal nonReentrant returns (uint256 settledAmount, IERC20 payableCurrency) {
        address oldLender = loanCoreV3.lenderNote().ownerOf(oldLoanId);
        payableCurrency = IERC20(oldLoanData.terms.payableCurrency);

        // Calculate settle amounts
        RolloverAmounts memory amounts = _calculateV3MigrationAmounts(
            oldLoanData,
            newTerms,
            lender,
            oldLender
        );

        // Collect funds based on settle amounts and total them
        settledAmount = 0;
        if (lender != oldLender) {
            // If new lender, take new principal from new lender
            payableCurrency.safeTransferFrom(lender, address(this), amounts.amountFromLender);
            settledAmount += amounts.amountFromLender;
        }

        if (amounts.needFromBorrower > 0) {
            // Borrower owes from old loan
            payableCurrency.safeTransferFrom(borrower, address(this), amounts.needFromBorrower);
            settledAmount += amounts.needFromBorrower;
        } else if (amounts.leftoverPrincipal > 0 && lender == oldLender) {
            // If same lender, and new amount from lender is greater than old loan repayment amount,
            // take the difference from the lender
            payableCurrency.safeTransferFrom(lender, address(this), amounts.leftoverPrincipal);
            settledAmount += amounts.leftoverPrincipal;
        }
    }

    function _calculateV3MigrationAmounts(
        LoanLibraryV3.LoanData memory oldLoanData,
        LoanLibrary.LoanTerms calldata newTerms,
        address lender,
        address oldLender
    ) internal view returns (RolloverAmounts memory amounts) {
        // get total interest to close v3 loan
        uint256 interest = repaymentControllerV3.getInterestAmount(
            oldLoanData.terms.principal,
            oldLoanData.terms.proratedInterestRate
        );
        amounts.interestAmount = interest;
        uint256 repayAmount = oldLoanData.terms.principal + interest;

        // Calculate amount to be sent to borrower for new loan
        uint256 borrowerOwedForNewLoan = newTerms.principal;

        // Calculate amount to be collected from the lender for new loan
        amounts.amountFromLender = newTerms.principal;

        // Calculate net amounts based on if repayment amount for old loan is greater than
        // new loan principal minus fees
        if (repayAmount > borrowerOwedForNewLoan) {
            // amount to collect from borrower
            // new loan principal is less than old loan repayment amount
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
}
