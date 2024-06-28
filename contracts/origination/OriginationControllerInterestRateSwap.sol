// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "./OriginationControllerBase.sol";

import "../interfaces/IOriginationControllerInterestRateSwap.sol";
import "../interfaces/IFeeController.sol";
import "../interfaces/IVaultFactory.sol";

import "../libraries/Constants.sol";

import {
    OCIRS_ZeroAddress,
    OCIRS_InvalidPair
} from "../errors/Lending.sol";

/**
 * @title OriginationControllerInterestRateSwap
 * @author Non-Fungible Technologies, Inc.
 *
 * This controller allows users to secure a fixed interest rate on their variable rate tokens. Two users agree on a
 * fixed rate, then lock the total fixed interest amount along with the tokens that generate variable yield. These
 * locked tokens are used to initiate a loan in Loan Core under the agreed terms. The user seeking a fixed rate
 * effectively locks in their interest, while the other party has the option to repay the loan later and reclaim all
 * the variable interest rate tokens.
 */
contract OriginationControllerInterestRateSwap is
    IOriginationControllerInterestRateSwap,
    OriginationControllerBase,
    ReentrancyGuard,
    ERC721Holder,
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

    // ========================================== ORIGINATION ===========================================

    /**
     * @notice Initializes a new interest rate swap and registers the collateral with Loan Core.
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
     *
     * @return loanId                       The unique ID of the new loan.
     * @return bundleId                     The ID of the new asset vault.
     */
    function initializeSwap(
        LoanLibrary.LoanTerms calldata loanTerms,
        SwapData calldata swapData,
        address borrower,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties
    ) public override returns (uint256 loanId, uint256 bundleId) {
        // input validation
        originationHelpers.validateLoanTerms(loanTerms);

        _validateSwap(loanTerms, swapData);

        // signature validation
        Side neededSide = isSelfOrApproved(borrower, msg.sender) ? Side.LEND : Side.BORROW;

        address signingCounterparty = neededSide == Side.LEND ? lender : borrower;
        address callingCounterparty = neededSide == Side.LEND ? borrower : lender;

        (bytes32 sighash, address externalSigner) = recoverInterestRateSwapSignature(
            loanTerms,
            sig,
            sigProperties,
            swapData.vaultedCurrency,
            neededSide,
            signingCounterparty
        );

        _validateCounterparties(signingCounterparty, callingCounterparty, msg.sender, externalSigner, sig, sighash);

        // consume signer nonce
        loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);

        // initialize loan
        (loanId, bundleId) = _initialize(loanTerms, swapData, borrower, lender);
    }

    // =========================================== HELPERS ==============================================

    /**
     * @notice Check that the swap data is valid for the provided loan terms.
     *
     * @param loanTerms                     The terms of the loan.
     * @param swapData                      The swap data to validate.
     */
    function _validateSwap(
        LoanLibrary.LoanTerms calldata loanTerms,
        SwapData calldata swapData
    ) internal view {
        bytes32 key = keccak256(
            abi.encodePacked(
                loanTerms.payableCurrency,
                swapData.vaultedCurrency,
                swapData.payableToVaultedCurrencyRatio
            )
        );

        if(!currencyPairs[key]) revert OCIRS_InvalidPair(loanTerms.payableCurrency, swapData.vaultedCurrency);
    }

    /**
     * @notice Determine the external signer for a signature.
     *
     * @param loanTerms                     The terms of the loan.
     * @param sig                           The signature, with v, r, s fields.
     * @param sigProperties                 Signature nonce and max uses for this nonce.
     * @param vaultedCurrency               The currency to be vaulted.
     * @param side                          The side of the loan being signed.
     * @param signingCounterparty           The address of the counterparty who signed the terms.
     *
     * @return sighash                      The hash that was signed.
     * @return signer                       The address of the recovered signer.
     */
    function recoverInterestRateSwapSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        address vaultedCurrency,
        Side side,
        address signingCounterparty
    ) public view override returns (bytes32 sighash, address signer) {
        bytes32 loanHash = OriginationLibrary.encodeLoanWithInterestRateSwap(
            loanTerms,
            sigProperties,
            vaultedCurrency,
            uint8(side),
            signingCounterparty
        );

        sighash = _hashTypedDataV4(loanHash);
        signer = ECDSA.recover(sighash, sig.v, sig.r, sig.s);
    }

    /**
     * @notice Mint a new asset vault, then deposit the vaulted currency amounts from both parties
     *         into the asset vault. Update the loan terms to reflect the new bundle ID. Then,
     *         tell LoanCore to create a new loan.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param swapData                      The interest rate swap data.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     *
     * @return loanId                       The unique ID of the new loan.
     * @return bundleId                     The ID of the new asset vault.
     */
    function _initialize(
        LoanLibrary.LoanTerms calldata loanTerms,
        SwapData calldata swapData,
        address borrower,
        address lender
    ) internal nonReentrant returns (uint256 loanId, uint256 bundleId) {
        // calculate the vaulted currency amounts for each party
        uint256 totalInterest = loanTerms.principal * loanTerms.durationSecs * loanTerms.interestRate
            / (Constants.BASIS_POINTS_DENOMINATOR * Constants.SECONDS_IN_YEAR);
        uint256 borrowerDepositAmount = totalInterest * swapData.payableToVaultedCurrencyRatio;
        uint256 lenderDepositAmount = loanTerms.principal * swapData.payableToVaultedCurrencyRatio;

        // get fee snapshot from fee controller
        LoanLibrary.FeeSnapshot memory feeSnapshot = feeController.getFeeSnapshot();

        // create new asset vault to hold the collateral
        bundleId = vaultFactory.initializeBundle(address(this));
        address vaultAddress = address(uint160(bundleId));

        // update loan terms with bundle ID
        LoanLibrary.LoanTerms memory loanTermsMem = loanTerms;
        loanTermsMem.collateralId = bundleId;

        // transfer borrower's tokens into vault
        IERC20(swapData.vaultedCurrency).safeTransferFrom(borrower, vaultAddress, borrowerDepositAmount);

        // transfer lender's tokens into vault
        IERC20(swapData.vaultedCurrency).safeTransferFrom(lender, vaultAddress,lenderDepositAmount);

        // transfer vault to loan core
        IERC721(address(vaultFactory)).transferFrom(address(this), address(loanCore), bundleId);

        // create loan in LoanCore
        loanId = loanCore.startLoan(lender, borrower, loanTermsMem, feeSnapshot);
    }

    // ============================================ ADMIN ===============================================

    /**
     * @notice Whitelist a currency pair to be used for interest rate swaps. The first currency is the currency
     *         that is set in the loan terms. The second currency is the collateral currency. Additionally, a
     *         ratio is included to ensure that a collateral currencies can be used with loan terms currencies
     *         that have fewer decimal places.
     *
     * @dev ratio = vaulted currency decimals (currency2) / collateral currency decimals (currency1)
     *      i.e. ratio = (1 uSDCe) / (1 USDC) = 1e18 / 1e6 = 1e12
     * @dev The pair ratio is defined as the vaulted currency decimals divided by the collateral currency decimals.
     *      This ratio is used to compare currency amounts when they use different decimal places. It is very important
     *      to understand that this ratio is designed such that the decimal places of the loan terms currency must
     *      be less than or equal to the decimal places of the collateral currency. This is highly TRUSTED INPUT
     *      that the owner of the contract must follow and ensure the ratio is calculated correctly.
     *
     * @param currency1                  The address of the loan terms payable currency.
     * @param currency2                  The address of the collateral currency, aka the vaulted currency.
     * @param ratio                      The ratio of the pair.
     * @param isAllowed                  Whether the pair is allowed.
     */
    function setPair(address currency1, address currency2, uint256 ratio, bool isAllowed) external onlyOwner {
        bytes32 key = keccak256(abi.encodePacked(currency1, currency2, ratio));

        currencyPairs[key] = isAllowed;
    }
}
