// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "../OriginationController.sol";

import "../interfaces/IMigrationBase.sol";

import "../v3/interfaces/ILoanCoreV3.sol";
import "../v3/interfaces/IRepaymentControllerV3.sol";
import "../v3/libraries/LoanLibraryV3.sol";

import {
    M_CallerNotBorrower,
    M_UnknownBorrower,
    M_UnknownCaller,
    M_BorrowerNotCached,
    M_BorrowerNotReset,
    M_StateAlreadySet,
    M_Paused
} from "../errors/MigrationErrors.sol";

contract OriginationControllerMigrate is IMigrationBase, OriginationController, ERC721Holder {
    using SafeERC20 for IERC20;

    /// @notice Balancer vault
    address private constant VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    /// @notice V3 lending protocol
    address private constant loanCoreV3 = 0x89bc08BA00f135d608bc335f6B33D7a9ABCC98aF;
    address private constant borrowerNoteV3 = 0xe5B12BEfaf3a91065DA7FDD461dEd2d8F8ECb7BE;
    address private constant repaymentControllerV3 = 0x74241e1A9c021643289476426B9B70229Ab40D53;

    /// @notice State variable used for checking the inheriting contract initiated the flash
    ///         loan. When the migration function is called the borrowers address is cached here
    ///         and checked against the opData in the flash loan callback.
    address private borrower;

    /// @notice state variable for pausing the contract
    bool public paused;

    constructor(address _loanCore, address _feeController) OriginationController(_loanCore, _feeController) {}

    // ======================================= V3 MIGRATION =============================================

    function migrateV3Loan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata newTerms,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external override whenNotPaused whenBorrowerReset {
        LoanLibraryV3.LoanData memory oldLoanData = ILoanCoreV3(loanCoreV3).getLoan(oldLoanId);

        // ------------ Migration Validation ------------
        if (oldLoanData.state != LoanLibraryV3.LoanState.Active) revert OC_InvalidState(uint8(oldLoanData.state));

        _validateV3Migration(oldLoanData.terms, newTerms, oldLoanId);

        (, address externalSigner) = _recoverSignature(newTerms, sig, sigProperties, Side.LEND, itemPredicates);

        // revert if the signer is not the lender
        if (externalSigner != lender) revert OC_SideMismatch(externalSigner);

        // ------------ Migration Execution ------------

        // pull BorrowerNote from the caller so that this contract receives collateral upon V3 repayment
        // borrower must approve this withdrawal
        IPromissoryNote(borrowerNoteV3).transferFrom(msg.sender, address(this), oldLoanId);

        loanCore.consumeNonce(lender, sigProperties.nonce, sigProperties.maxUses);

        // pull the BorrowerNote and distribute settled amounts
        (
            OriginationLibrary.RolloverAmounts memory amounts,
            bool flashLoanTrigger
        ) = _migrate(oldLoanId, oldLoanData, newTerms.principal, msg.sender, lender);

        if (flashLoanTrigger) {
            // cache borrower address for flash loan callback
            borrower = msg.sender;

            _initiateFlashLoan(oldLoanId, newTerms, itemPredicates, msg.sender, lender,  amounts);
        } else {
            _repayLoan(IERC20(newTerms.payableCurrency), oldLoanId, amounts.amountFromLender + amounts.needFromBorrower - amounts.amountToBorrower);

            // initialize v4 loan
            _initializeMigrationLoan(newTerms, itemPredicates, msg.sender, lender);

            if (amounts.amountToBorrower > 0) {
                // If new principal is greater than old loan repayment amount, send the difference to the borrower
                IERC20(newTerms.payableCurrency).safeTransfer(msg.sender, amounts.amountToBorrower);
            }
        }
    }

    // =================================== MIGRATION VALIDATION =========================================

    /**
     * @notice Validates that the migration is valid. If any of these conditionals are not met
     *         the transaction will revert.
     *
     * @param sourceLoanTerms           The terms of the V2 loan.
     * @param newLoanTerms              The terms of the V3 loan.
     * @param borrowerNoteId            The ID of the borrowerNote for the old loan.
     */
    // solhint-disable-next-line code-complexity
    function _validateV3Migration(
        LoanLibraryV3.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms memory newLoanTerms,
        uint256 borrowerNoteId
    ) internal view {
        // ------------- Caller Validation -------------
        address _borrower = IPromissoryNote(borrowerNoteV3).ownerOf(borrowerNoteId);

        if (_borrower != msg.sender) revert M_CallerNotBorrower();

        // ------------- Migration Terms Validation -------------
        // currency must be the same
        if (sourceLoanTerms.payableCurrency != newLoanTerms.payableCurrency) {
            revert OC_RolloverCurrencyMismatch(sourceLoanTerms.payableCurrency, newLoanTerms.payableCurrency);
        }

        // collateral address and id must be the same
        if (sourceLoanTerms.collateralAddress != newLoanTerms.collateralAddress || sourceLoanTerms.collateralId != newLoanTerms.collateralId) {
            revert OC_RolloverCollateralMismatch(
                sourceLoanTerms.collateralAddress,
                sourceLoanTerms.collateralId,
                newLoanTerms.collateralAddress,
                newLoanTerms.collateralId
            );
        }

        // ------------- New LoanTerms Validation -------------
        // principal must be greater than or equal to the configured minimum
        if (newLoanTerms.principal < allowedCurrencies[newLoanTerms.payableCurrency].minPrincipal) revert OC_PrincipalTooLow(newLoanTerms.principal);

        // loan duration must be greater or equal to 1 hr and less or equal to 3 years
        if (newLoanTerms.durationSecs < 3600 || newLoanTerms.durationSecs > 94_608_000) revert OC_LoanDuration(newLoanTerms.durationSecs);

        // interest rate must be greater than or equal to 0.01% and less or equal to 1,000,000%
        if (newLoanTerms.interestRate < 1 || newLoanTerms.interestRate > 1e8) revert OC_InterestRate(newLoanTerms.interestRate);

        // signature must not have already expired
        if (newLoanTerms.deadline < block.timestamp) revert OC_SignatureIsExpired(newLoanTerms.deadline);
    }

    // ========================================= HELPERS ================================================

    function _migrate(
        uint256 oldLoanId,
        LoanLibraryV3.LoanData memory oldLoanData,
        uint256 newPrincipalAmount,
        address borrower_,
        address lender
    ) internal nonReentrant returns (OriginationLibrary.RolloverAmounts memory amounts, bool flashLoanTrigger) {
        address oldLender = ILoanCoreV3(loanCoreV3).lenderNote().ownerOf(oldLoanId);
        IERC20 payableCurrency = IERC20(oldLoanData.terms.payableCurrency);

        // Calculate settle amounts
        (amounts) = _calculateV3MigrationAmounts(
            oldLoanData,
            newPrincipalAmount,
            lender,
            oldLender
        );

        // Collect funds based on settle amounts and total them
        if (lender != oldLender) {
            // If new lender, take new principal from new lender
            payableCurrency.safeTransferFrom(lender, address(this), amounts.amountFromLender);
        } else {
            // initiate flash loan for the funds needed to repay v3 loan
            flashLoanTrigger = true;
            // if same lender and new principal is greater than old loan repayment amount,
            // send the difference to the lender
            if (amounts.amountFromLender > 0) {
                payableCurrency.safeTransferFrom(lender, address(this), amounts.leftoverPrincipal);
            }
        }

        if (amounts.needFromBorrower > 0) {
            // Borrower owes from old loan
            payableCurrency.safeTransferFrom(borrower_, address(this), amounts.needFromBorrower);
        }
    }

    function _calculateV3MigrationAmounts(
        LoanLibraryV3.LoanData memory oldLoanData,
        uint256 newPrincipalAmount,
        address lender,
        address oldLender
    ) internal view returns (OriginationLibrary.RolloverAmounts memory amounts) {
        // get total interest to close v3 loan
        uint256 interest = IRepaymentControllerV3(repaymentControllerV3).getInterestAmount(
            oldLoanData.terms.principal,
            oldLoanData.terms.proratedInterestRate
        );

       return(
            OriginationLibrary.rolloverAmounts(
                oldLoanData.terms.principal,
                interest,
                newPrincipalAmount,
                lender,
                oldLender,
                0,
                0,
                0
            )
        );
    }

    // ======================================= FLASH LOAN OPS ===========================================

    function _initiateFlashLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms memory newLoanTerms,
        LoanLibrary.Predicate[] memory itemPredicates,
        address borrower_,
        address lender,
        OriginationLibrary.RolloverAmounts memory _amounts
    ) internal {
        IERC20[] memory assets = new IERC20[](1);
        assets[0] = IERC20(newLoanTerms.payableCurrency);

        // flash loan amount = new principal + any difference supplied by borrower
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _amounts.amountFromLender + _amounts.needFromBorrower - _amounts.amountToBorrower;

        bytes memory params = abi.encode(
            OriginationLibrary.OperationData(
                {
                    oldLoanId: oldLoanId,
                    newLoanTerms: newLoanTerms,
                    borrower: borrower_,
                    lender: lender,
                    itemPredicates: itemPredicates,
                    migrationAmounts: _amounts
                }
            )
        );

        // Flash loan based on principal + interest
        IVault(VAULT).flashLoan(this, assets, amounts, params);
    }

    /**
     * @notice Callback function for flash loan.
     *
     * @dev The caller of this function must be the lending pool.
     *
     * @param assets                 The ERC20 address that was borrowed in Flash Loan.
     * @param amounts                The amount that was borrowed in Flash Loan.
     * @param feeAmounts             The fees that are due to the lending pool.
     * @param params                 The data to be executed after receiving Flash Loan.
     */
    function receiveFlashLoan(
        IERC20[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata params
    ) external nonReentrant {
        if (msg.sender != VAULT) revert M_UnknownCaller(msg.sender, VAULT);

        OriginationLibrary.OperationData memory opData = abi.decode(params, (OriginationLibrary.OperationData));

        // verify this contract started the flash loan
        if (opData.borrower != borrower) revert M_UnknownBorrower(opData.borrower, borrower);
        // borrower must be set
        if (borrower == address(0)) revert M_BorrowerNotCached();

        _executeOperation(assets, amounts, feeAmounts, opData);
    }

    function _executeOperation(
        IERC20[] calldata assets,
        uint256[] calldata amounts,
        uint256[] memory premiums,
        OriginationLibrary.OperationData memory opData
    ) internal {
        IERC20 asset = assets[0];

        _repayLoan(asset, opData.oldLoanId, amounts[0]);

        _initializeMigrationLoan(
            opData.newLoanTerms,
            opData.itemPredicates,
            borrower,
            opData.lender
        );

        // pull funds from the lender to repay the flash loan
        IERC20(opData.newLoanTerms.payableCurrency).safeTransferFrom(opData.lender, address(this), opData.migrationAmounts.amountFromLender - opData.migrationAmounts.leftoverPrincipal);

        if (opData.migrationAmounts.amountToBorrower > 0) {
            // If new principal is greater than old loan repayment amount, send the difference to the borrower
            IERC20(opData.newLoanTerms.payableCurrency).safeTransfer(borrower, opData.migrationAmounts.amountToBorrower);
        }

        // Make flash loan repayment
        // Balancer requires a transfer back the vault
        asset.safeTransfer(VAULT, amounts[0] + premiums[0]);
    }

    /**
     * @notice Helper function to repay the V3 loan.
     *
     * @param payableCurrency              Payable currency for the loan terms.
     * @param borrowerNoteId               ID of the borrowerNote for the loan to be repaid.
     * @param repayAmount                  The amount to be repaid on V3
     */
    function _repayLoan(
        IERC20 payableCurrency,
        uint256 borrowerNoteId,
        uint256 repayAmount
    ) internal {
        // approve LoanCoreV3 to take the total settled amount
        payableCurrency.safeApprove(loanCoreV3, repayAmount);

        // repay V3 loan, this contract receives the collateral
        IRepaymentControllerV3(repaymentControllerV3).repay(borrowerNoteId);
    }

    function _initializeMigrationLoan(
        LoanLibrary.LoanTerms memory newTerms,
        LoanLibrary.Predicate[] memory itemPredicates,
        address borrower_,
        address lender
    ) internal returns (uint256 newLoanId) {
        // transfer collateral to LoanCore
        IERC721(newTerms.collateralAddress).transferFrom(address(this), address(loanCore), newTerms.collateralId);

        // all post loan origination fees are set to zero for migrations
        LoanLibrary.FeeSnapshot memory feeSnapshot = LoanLibrary.FeeSnapshot({
            lenderDefaultFee: 0,
            lenderInterestFee: 0,
            lenderPrincipalFee: 0
        });

        // create loan in LoanCore
        newLoanId = loanCore.startLoan(lender, borrower_, newTerms, 0, 0, feeSnapshot);

        emit V3V4Rollover(lender, borrower_, newTerms.collateralId, newLoanId);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) _runPredicatesCheck(borrower_, lender, newTerms, itemPredicates);
    }

    // ========================================== ADMIN =================================================

    /**
     * @notice Function to be used by the contract owner to pause the contract.
     *
     * @dev This function is only to be used if a vulnerability is found in the
     *      V3 to V4 migration flow.
     *
     * @param _pause              The state to set the contract to.
     */
    function pause(bool _pause) external override onlyRole(MIGRATOR_ROLE) {
        if (paused == _pause) revert M_StateAlreadySet();

        paused = _pause;

        emit PausedStateChanged(_pause);
    }

    /**
     * @notice This function ensures that at the start of every flash loan sequence, the borrower
     *         state is reset to address(0). The migration function that inherit this modifier sets
     *         the borrower state when executing the migration. At the end of the migration execution
     *         the borrower state is always reset to address(0).
     */
    modifier whenBorrowerReset() {
        if (borrower != address(0)) revert M_BorrowerNotReset(borrower);

        _;

        borrower = address(0);
    }

    /**
     * @notice This modifier ensures the migration functionality is not paused.
     */
    modifier whenNotPaused() {
        if (paused) revert M_Paused();

        _;
    }
}