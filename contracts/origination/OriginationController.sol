// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";

import "./OriginationControllerBase.sol";

import "../interfaces/IOriginationController.sol";
import "../interfaces/IFeeController.sol";
import "../interfaces/IExpressBorrow.sol";

import "../libraries/FeeLookups.sol";

import { OC_InvalidState } from "../errors/Lending.sol";

import {
    OC_RolloverCurrencyMismatch,
    OC_RolloverCollateralMismatch,
    OC_ZeroAddress
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
    OriginationControllerBase,
    AccessControlEnumerable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    // ============================================ STATE ==============================================

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN");
    bytes32 public constant MIGRATION_MANAGER_ROLE = keccak256("MIGRATION_MANAGER");

    IFeeController public immutable feeController;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Creates a new origination controller contract.
     *
     * @dev For this controller to work, it needs to be granted the ORIGINATOR_ROLE
     *      in loan core after deployment.
     *
     * @param _originationHelpers           The address of the origination shared storage contract.
     * @param _loanCore                     The address of the loan core logic of the protocol.
     * @param _feeController                The address of the fee logic of the protocol.
     */
    constructor(
        address _originationHelpers,
        address _loanCore,
        address _feeController
    ) OriginationControllerBase(_originationHelpers, _loanCore) {
        if (_feeController == address(0)) revert OC_ZeroAddress("feeController");

        feeController = IFeeController(_feeController);

        _setupRole(ADMIN_ROLE, msg.sender);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);

        _setupRole(MIGRATION_MANAGER_ROLE, msg.sender);
        _setRoleAdmin(MIGRATION_MANAGER_ROLE, ADMIN_ROLE);
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

    // =========================================== HELPERS ===============================================

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
}
