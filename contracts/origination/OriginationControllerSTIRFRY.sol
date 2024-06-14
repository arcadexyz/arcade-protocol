// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./OriginationControllerBase.sol";

import "../interfaces/IFeeController.sol";
import "../interfaces/IVaultFactory.sol";

import "../libraries/OriginationLibrary.sol";
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
 *
 * TODO: Only support the vault factory as collateral. This is an invariant. Do we need the OriginationHelpers?
 * TODO: Interface...
 */

contract OriginationControllerSTIRFRY is
    EIP712,
    OriginationControllerBase,
    ReentrancyGuard,
    Ownable
{
    using SafeERC20 for IERC20;

    // ============================================ STATE ==============================================

    IFeeController public immutable feeController;
    IVaultFactory public immutable vaultFactory;

    /// @notice Mapping from hashed currency pair to whether it is allowed
    mapping(bytes32 => bool) public stirfryPairs;

    // ======================================== DATA STRUCTURES =========================================

    struct StirfryData {
        address vaultedCurrency;
        uint256 lenderVaultedCurrencyAmount;
        uint256 borrowerVaultedCurrencyAmount;
        uint256 vaultedToPayableCurrencyRatio;
    }

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Creates a new origination controller STIRFRY contract, also initializing
     *         the origination controller base contract.
     *
     * @dev For this controller to work, it needs to be granted the ORIGINATOR_ROLE
     *      in loan core after deployment.
     *
     * @param _originationHelpers           The address of the origination shared storage contract.
     * @param _loanCore                     The address of the loan core logic of the protocol.
     * @param _feeController                The address of the fee logic of the protocol.
     * @param _vaultFactory                 The address of the vault factory.
     */
    constructor(
        address _originationHelpers,
        address _loanCore,
        address _feeController,
        address _vaultFactory
    ) OriginationControllerBase(_originationHelpers, _loanCore) {
        if (_feeController == address(0)) revert OC_ZeroAddress("feeController");
        if (_vaultFactory == address(0)) revert OC_ZeroAddress("vaultFactory");

        feeController = IFeeController(_feeController);
        vaultFactory = IVaultFactory(_vaultFactory);
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
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     * @param sig                           The loan terms signature, with v, r, s fields, and possible extra data.
     * @param sigProperties                 Signature nonce and max uses for this nonce.
     * @param itemPredicates                The predicate rules for the items in the bundle.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function initializeStirfryLoan(
        LoanLibrary.LoanTerms calldata loanTerms,
        StirfryData calldata stirfryData,
        address borrower,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 loanId) {
        // input validation
        originationHelpers.validateLoanTerms(loanTerms);
        _validateStirfryTerms(loanTerms, stirfryData);

        // signature validation
        Side neededSide = isSelfOrApproved(borrower, msg.sender) ? Side.LEND : Side.BORROW;

        address signingCounterparty = neededSide == Side.LEND ? lender : borrower;
        address callingCounterparty = neededSide == Side.LEND ? borrower : lender;

        {
            (bytes32 sighash, address externalSigner) = _recoverSignature(loanTerms, sig, sigProperties, neededSide, signingCounterparty, itemPredicates);

            _validateCounterparties(signingCounterparty, callingCounterparty, msg.sender, externalSigner, sig, sighash);

            loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);
        }

        // initialize loan
        loanId = _initialize(loanTerms, stirfryData, borrower, lender);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationHelpers.runPredicatesCheck(borrower, lender, loanTerms, itemPredicates);
    }

    // =========================================== HELPERS ==============================================

    /**
     * @notice Validate that the stirfry data is valid for the given loan terms.
     *
     * @param loanTerms                     The terms of the loan.
     * @param stirfryData                   The stirfry data to validate.
     */
    function _validateStirfryTerms(
        LoanLibrary.LoanTerms calldata loanTerms,
        StirfryData calldata stirfryData
    ) internal view {
        // verify the vaulted currency is allowed to be paired with the loan terms payable currency
        bytes32 currencyHash = keccak256(abi.encodePacked(loanTerms.payableCurrency, stirfryData.vaultedCurrency, stirfryData.vaultedToPayableCurrencyRatio));
        require(stirfryPairs[currencyHash] == true, "OriginationController: Currency pair not allowed");

        // verify the vaulted currency amounts
        require(loanTerms.principal * stirfryData.vaultedToPayableCurrencyRatio == stirfryData.lenderVaultedCurrencyAmount, "OriginationController: Invalid principal amount");

        // calculate total interest due over the loan duration
        uint256 totalInterest = loanTerms.principal * loanTerms.durationSecs * loanTerms.interestRate
            / (Constants.BASIS_POINTS_DENOMINATOR * Constants.SECONDS_IN_YEAR);

        require(totalInterest * stirfryData.vaultedToPayableCurrencyRatio == stirfryData.borrowerVaultedCurrencyAmount, "OriginationController: Invalid interest amount");
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
     * @dev Perform loan initialization. Take custody of collateral, and tell LoanCore
     *      to create and start a loan.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function _initialize(
        LoanLibrary.LoanTerms calldata loanTerms,
        StirfryData calldata stirfryData,
        address borrower,
        address lender
    ) internal nonReentrant returns (uint256 loanId) {
        // get fee snapshot from fee controller
        (LoanLibrary.FeeSnapshot memory feeSnapshot) = feeController.getFeeSnapshot();

        // transfer fixed rate amount from borrower to lender's vault
        address vaultAddress = vaultFactory.instanceAt(loanTerms.collateralId);
        IERC20(stirfryData.vaultedCurrency).safeTransferFrom(
            borrower,
            vaultAddress,
            stirfryData.borrowerVaultedCurrencyAmount
        );

        // collect vault from lender and send to LoanCore
        IERC721(address(vaultFactory)).transferFrom(lender, address(loanCore), loanTerms.collateralId);

        // Create loan in LoanCore
        loanId = loanCore.startLoan(lender, borrower, loanTerms, feeSnapshot);
    }

    // ============================================ ADMIN ===============================================

    /**
     * @notice Set whether or not a currency pair is allowed to be paired. The first currency is the currency that
     *         is set in the loan terms. The second currency is the collateral currency.
     *
     * @dev the ratio is defined as one of the vaulted currencies divided by the collateral currency
     *
     * @param currency1                  The first currency in the pair.
     * @param currency2                  The second currency in the pair.
     * @param ratio                      The ratio of the pair.
     * @param isAllowed                  Whether the pair is allowed.
     */
    function setPair(address currency1, address currency2, uint256 ratio, bool isAllowed) external onlyOwner {
        require(currency1 != currency2, "OriginationController: Invalid currency pair");

        bytes32 key = keccak256(abi.encodePacked(currency1, currency2, ratio));

        stirfryPairs[key] = isAllowed;
    }
}
