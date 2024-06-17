// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./OriginationControllerBase.sol";

import "../interfaces/IOriginationControllerSTIRFRY.sol";
import "../interfaces/IFeeController.sol";
import "../interfaces/IVaultFactory.sol";

import "../libraries/Constants.sol";

import {
    OCS_ZeroAddress,
    OCS_InvalidStirfryPair,
    OCS_InvalidPrincipalAmounts,
    OCS_InvalidVaultAmount,
    OCS_InvalidInterestAmounts
} from "../errors/Lending.sol";

/**
 * @title OriginationControllerSTIRFRY
 * @author Non-Fungible Technologies, Inc.
 *
 * STIRFRY - Set Term Interest Rate Fixed Rate Yield
 *
 * This contract is similar to the vanilla OriginationController, with a few key changes:
 * 1). The collateral is collected from the lender instead of the borrower.
 * 2). The borrower does not receive any principal at the start of the loan. Instead, the borrower deposits the
 *     interest amount into the lenders vault. This vault is the vault that is being used for collateral in the loan.
 * 3). There are no loan rollovers.
 *
 * In a STIRFRY loan scenario, a lender will mint a vault and deposit into the vault an ERC20 that accumulates some
 * sort of variable yield. From the lender's perspective, they want to de-risk and lock in a fixed rate yield on
 * their variable yield ERC20 token. This is where the borrower comes in, a borrower in a STIRFRY scenario will deposit
 * the same ERC20 into the vault that the lender deposited. The amount of ERC20 that the borrower deposits is
 * equivalent to the fixed rate yield that the lender is signaling in their signed loan terms. When a borrower
 * deposits the fixed rate yield amount into the lender's vault, a loan will be originated. Upon loan origination,
 * the borrower will not receive any principal. Instead, they are reserving the right to repay the loan at any time
 * and receive all of the vaulted collateral, which may be worth more than at the time of loan origination due to the
 * variable yield accumulated while the assets are in loan. In instances where the borrower defaults on the loan,
 * the lender will collect the collateral from the loan which includes the fixed rate yield amount the borrower
 * deposited at the start the loan.
 *
 * Due to how OriginationController counterparty signatures work, it is also possible for the borrower to sign the
 * loan terms. In this case, the lender will start the loan, and the borrower's collateral will automatically be
 * collected by the protocol.
 */

contract OriginationControllerSTIRFRY is
    IOriginationControllerSTIRFRY,
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

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Creates a new origination controller STIRFRY contract, as well as initializing
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
        if (_feeController == address(0)) revert OCS_ZeroAddress("feeController");
        if (_vaultFactory == address(0)) revert OCS_ZeroAddress("vaultFactory");

        feeController = IFeeController(_feeController);
        vaultFactory = IVaultFactory(_vaultFactory);
    }

    // ======================================= LOAN ORIGINATION =========================================

    /**
     * @notice Initializes a new STIRFRY loan with Loan Core.
     *
     * @notice If item predicates are passed, they are used to verify collateral.
     *
     * @dev The caller must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must come from the opposite side of the loan as the caller.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param stirfryData                   The stirfry data to initialize the loan with.
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

        address vaultAddress = vaultFactory.instanceAt(loanTerms.collateralId);
        _validateStirfryTerms(loanTerms, stirfryData, vaultAddress);

        {
            // signature validation
            Side neededSide = isSelfOrApproved(borrower, msg.sender) ? Side.LEND : Side.BORROW;

            address signingCounterparty = neededSide == Side.LEND ? lender : borrower;
            address callingCounterparty = neededSide == Side.LEND ? borrower : lender;

            (bytes32 sighash, address externalSigner) = _recoverSignature(loanTerms, sig, sigProperties, neededSide, signingCounterparty, itemPredicates);

            _validateCounterparties(signingCounterparty, callingCounterparty, msg.sender, externalSigner, sig, sighash);

            // consume signer nonce
            loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);
        }

        // initialize loan
        loanId = _initialize(loanTerms, stirfryData, vaultAddress, borrower, lender);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationHelpers.runPredicatesCheck(borrower, lender, loanTerms, itemPredicates);
    }

    // =========================================== HELPERS ==============================================

    /**
     * @notice Validate that the stirfry data provided is valid for the given loan terms.
     *
     * @param loanTerms                     The terms of the loan.
     * @param stirfryData                   The stirfry data to validate.
     * @param vaultAddress                  The address of the vault.
     */
    function _validateStirfryTerms(
        LoanLibrary.LoanTerms calldata loanTerms,
        StirfryData calldata stirfryData,
        address vaultAddress
    ) internal view {
        // verify the vaulted currency is allowed to be paired with the loan terms payable currency
        bytes32 currencyHash = keccak256(
            abi.encodePacked(
                loanTerms.payableCurrency,
                stirfryData.vaultedCurrency,
                stirfryData.vaultedToPayableCurrencyRatio
            )
        );
        if(stirfryPairs[currencyHash] != true)
            revert OCS_InvalidStirfryPair(loanTerms.payableCurrency, stirfryData.vaultedCurrency);

        // verify the vaulted currency amounts
        if(loanTerms.principal * stirfryData.vaultedToPayableCurrencyRatio != stirfryData.lenderVaultedCurrencyAmount)
            revert OCS_InvalidPrincipalAmounts(
                loanTerms.principal,
                stirfryData.vaultedToPayableCurrencyRatio,
                stirfryData.lenderVaultedCurrencyAmount
            );

        // verify that the vault holds the lenderVaultedCurrencyAmount
        uint256 vaultAmount = IERC20(stirfryData.vaultedCurrency).balanceOf(vaultAddress);
        if(vaultAmount != stirfryData.lenderVaultedCurrencyAmount)
            revert OCS_InvalidVaultAmount(vaultAmount, stirfryData.lenderVaultedCurrencyAmount);

        // calculate the total interest due over the loan duration
        uint256 totalInterest = loanTerms.principal * loanTerms.durationSecs * loanTerms.interestRate
            / (Constants.BASIS_POINTS_DENOMINATOR * Constants.SECONDS_IN_YEAR);

        // verify interest amounts
        if(totalInterest * stirfryData.vaultedToPayableCurrencyRatio != stirfryData.borrowerVaultedCurrencyAmount)
            revert OCS_InvalidInterestAmounts(
                totalInterest,
                stirfryData.vaultedToPayableCurrencyRatio,
                stirfryData.borrowerVaultedCurrencyAmount
            );
    }

    /**
     * @dev Perform loan initialization. Pull fixed interest amount from the borrower.
     *      Take custody of collateral form the lender. Tell LoanCore to create and start a loan.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param stirfryData                   The stirfry data to initialize the loan with.
     * @param vaultAddress                  The address of the vault.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function _initialize(
        LoanLibrary.LoanTerms calldata loanTerms,
        StirfryData calldata stirfryData,
        address vaultAddress,
        address borrower,
        address lender
    ) internal nonReentrant returns (uint256 loanId) {
        // get fee snapshot from fee controller
        (LoanLibrary.FeeSnapshot memory feeSnapshot) = feeController.getFeeSnapshot();

        // transfer fixed interest amount from borrower to lender's vault
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
     * @notice Whitelist a currency pair to be used for stirfry loans. The first currency is the currency that
     *         is set in the loan terms. The second currency is the collateral currency.
     *
     * @dev The pair ratio is defined as the vaulted currency decimals divided by the collateral currency decimals.
     *      This ratio is used to compare currency amounts when they use different decimal places. It is very important
     *      to understand that this ratio is designed such that the decimal places of the loan terms currency must
     *      be less than the decimal places of the collateral currency. For scenarios where the loan terms currency
     *      decimals are greater than the collateral currency, input validations will fail.
     *
     * @param currency1                  The first currency in the pair.
     * @param currency2                  The second currency in the pair.
     * @param ratio                      The ratio of the pair.
     * @param isAllowed                  Whether the pair is allowed.
     */
    function setPair(address currency1, address currency2, uint256 ratio, bool isAllowed) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(currency1, currency2, ratio));

        stirfryPairs[key] = isAllowed;
    }
}
