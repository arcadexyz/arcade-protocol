// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./OriginationControllerBase.sol";

import "../interfaces/IOriginationControllerInterestRateSwap.sol";
import "../interfaces/IFeeController.sol";
import "../interfaces/IVaultFactory.sol";

import "../libraries/Constants.sol";

import {
    OCIRS_ZeroAddress,
    OCIRS_InvalidPair,
    OCIRS_InvalidPrincipalAmounts,
    OCIRS_InvalidVaultAmount,
    OCIRS_InvalidInterestAmounts
} from "../errors/Lending.sol";

/**
 * @title OriginationControllerInterestRateSwap
 * @author Non-Fungible Technologies, Inc.
 *
 * TODO: Add documentation
 */

contract OriginationControllerInterestRateSwap is
    IOriginationControllerInterestRateSwap,
    OriginationControllerBase,
    ReentrancyGuard,
    Ownable
{
    using SafeERC20 for IERC20;

    // ============================================ STATE ==============================================

    IFeeController public immutable feeController;
    IVaultFactory public immutable vaultFactory;

    /// @notice Mapping from hashed currency pair to whether it is allowed
    mapping(bytes32 => bool) public currencyPairs;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Creates a new origination controller interest rate swap contract, as well as initializing
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
        if (_feeController == address(0)) revert OCIRS_ZeroAddress("feeController");
        if (_vaultFactory == address(0)) revert OCIRS_ZeroAddress("vaultFactory");

        feeController = IFeeController(_feeController);
        vaultFactory = IVaultFactory(_vaultFactory);
    }

    // ======================================= LOAN ORIGINATION =========================================

    /**
     * @notice Initializes a new interest rate swap and registers the collateral with Loan Core.
     *
     * @notice If item predicates are passed, they are used to verify collateral.
     *
     * @dev The caller must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must come from the opposite side of the loan as the caller.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param swapData                      The data to initialize the swap with.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     * @param sig                           The loan terms signature, with v, r, s fields, and possible extra data.
     * @param sigProperties                 Signature nonce and max uses for this nonce.
     * @param itemPredicates                The predicate rules for the items in the bundle.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function initializeSwap(
        LoanLibrary.LoanTerms calldata loanTerms,
        SwapData calldata swapData,
        address borrower,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 loanId) {
        // input validation
        originationHelpers.validateLoanTerms(loanTerms);

        address vaultAddress = vaultFactory.instanceAt(loanTerms.collateralId);
        _validateSwap(loanTerms, swapData, vaultAddress);

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
        loanId = _initialize(loanTerms, swapData, vaultAddress, borrower, lender);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationHelpers.runPredicatesCheck(borrower, lender, loanTerms, itemPredicates);
    }

    // =========================================== HELPERS ==============================================

    /**
     * @notice Check that the interest rate swap data is valid for the provided loan terms.
     *
     * @param loanTerms                     The terms of the loan.
     * @param swapData                      The swap data to validate.
     * @param vaultAddress                  The address of the vault.
     */
    function _validateSwap(
        LoanLibrary.LoanTerms calldata loanTerms,
        SwapData calldata swapData,
        address vaultAddress
    ) internal view {
        // verify the vaulted currency is allowed to be paired with the loan terms payable currency
        bytes32 currencyHash = keccak256(
            abi.encodePacked(
                loanTerms.payableCurrency,
                swapData.vaultedCurrency,
                swapData.payableToVaultedCurrencyRatio
            )
        );
        if(currencyPairs[currencyHash] != true)
            revert OCIRS_InvalidPair(loanTerms.payableCurrency, swapData.vaultedCurrency);

        // verify the vaulted currency amounts
        if(loanTerms.principal * swapData.payableToVaultedCurrencyRatio != swapData.lenderVaultedCurrencyAmount)
            revert OCIRS_InvalidPrincipalAmounts(
                loanTerms.principal,
                swapData.payableToVaultedCurrencyRatio,
                swapData.lenderVaultedCurrencyAmount
            );

        // verify that the vault holds the lenderVaultedCurrencyAmount
        uint256 vaultAmount = IERC20(swapData.vaultedCurrency).balanceOf(vaultAddress);
        if(vaultAmount != swapData.lenderVaultedCurrencyAmount)
            revert OCIRS_InvalidVaultAmount(vaultAmount, swapData.lenderVaultedCurrencyAmount);

        // calculate the total interest due over the loan duration
        uint256 totalInterest = loanTerms.principal * loanTerms.durationSecs * loanTerms.interestRate
            / (Constants.BASIS_POINTS_DENOMINATOR * Constants.SECONDS_IN_YEAR);

        // verify interest amounts
        if(totalInterest * swapData.payableToVaultedCurrencyRatio != swapData.borrowerVaultedCurrencyAmount)
            revert OCIRS_InvalidInterestAmounts(
                totalInterest,
                swapData.payableToVaultedCurrencyRatio,
                swapData.borrowerVaultedCurrencyAmount
            );
    }

    /**
     * @notice Perform loan initialization. Pull fixed interest amount from the borrower and add to vault.
     *         Take custody of collateral form the lender. Tell LoanCore to create and start a loan.
     *
     * @dev The only collateral accepted by this contract is a Vault Factory vault.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param swapData                      The interest rate swap data.
     * @param vaultAddress                  The address of the vault.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function _initialize(
        LoanLibrary.LoanTerms calldata loanTerms,
        SwapData calldata swapData,
        address vaultAddress,
        address borrower,
        address lender
    ) internal nonReentrant returns (uint256 loanId) {
        // get fee snapshot from fee controller
        (LoanLibrary.FeeSnapshot memory feeSnapshot) = feeController.getFeeSnapshot();

        // transfer fixed interest amount from borrower to lender's vault
        IERC20(swapData.vaultedCurrency).safeTransferFrom(
            borrower,
            vaultAddress,
            swapData.borrowerVaultedCurrencyAmount
        );

        // collect vault from lender and send to LoanCore
        IERC721(address(vaultFactory)).transferFrom(lender, address(loanCore), loanTerms.collateralId);

        // create loan in LoanCore
        loanId = loanCore.startLoan(lender, borrower, loanTerms, feeSnapshot);
    }

    // ============================================ ADMIN ===============================================

    /**
     * @notice Whitelist a currency pair to be used for interest rate swaps. The first currency is the currency
     *         that is set in the loan terms. The second currency is the collateral currency.
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

        currencyPairs[key] = isAllowed;
    }
}
