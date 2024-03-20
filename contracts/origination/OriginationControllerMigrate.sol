// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "./OriginationController.sol";

import "../interfaces/IMigrationBase.sol";

import "../v3/interfaces/ILoanCoreV3.sol";
import "../v3/interfaces/IRepaymentControllerV3.sol";
import "../v3/libraries/LoanLibraryV3.sol";

import {
    OCM_CallerNotBorrower,
    OCM_UnknownBorrower,
    OCM_UnknownCaller,
    OCM_BorrowerNotCached,
    OCM_BorrowerNotReset,
    OCM_StateAlreadySet,
    OCM_Paused,
    OCM_InvalidState,
    OCM_SideMismatch,
    OCM_CurrencyMismatch,
    OCM_CollateralMismatch
} from "../errors/Lending.sol";

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

    constructor(
        address _originationConfiguration,
        address _loanCore,
        address _feeController
    ) OriginationController(_originationConfiguration, _loanCore, _feeController) {}

    // ======================================= V3 MIGRATION =============================================

    /**
     * @notice Migration an active loan on v3 to v4. This function validates new loan terms against the old terms.
     *         calculates the amounts needed to settle the old loan, and then executes the migration.
     *
     * @dev This function is only callable by the borrower of the loan.
     * @dev This function is only callable when the migration flow is not paused.
     * @dev For migrations where the lender is the same, a flash loan is initiated to repay the old loan.
     *      In order for the flash loan to be repaid, the lender must have approved this contract to
     *      pull the total amount needed to repay the loan.
     *
     * @param oldLoanId                 The ID of the v3 loan to be migrated.
     * @param newTerms                  The terms of the new loan.
     * @param lender                    The address of the new lender.
     * @param sig                       The signature of the loan terms.
     * @param sigProperties             The properties of the signature.
     * @param itemPredicates            The predicates for the loan.
     */
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
        if (oldLoanData.state != LoanLibraryV3.LoanState.Active) revert OCM_InvalidState(uint8(oldLoanData.state));

        _validateV3Migration(oldLoanData.terms, newTerms, oldLoanId);

        {
            (bytes32 sighash, address externalSigner) = _recoverSignature(newTerms, sig, sigProperties, Side.LEND, lender, itemPredicates, bytes(""));

            // counterparty validation
            if (!isSelfOrApproved(lender, externalSigner) && !OriginationLibrary.isApprovedForContract(lender, sig, sighash)) {
                revert OCM_SideMismatch(externalSigner);
            }

            // consume v4 nonce
            loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);
        }

        // ------------ Migration Execution ------------

        // collect and distribute settled amounts
        (
            OriginationLibrary.RolloverAmounts memory amounts,
            LoanLibrary.FeeSnapshot memory feeSnapshot,
            uint256 repayAmount,
            bool flashLoanTrigger
        ) = _migrate(oldLoanId, oldLoanData, newTerms.principal, msg.sender, lender);

        // repay v3 loan
        if (flashLoanTrigger) {
            _initiateFlashLoan(oldLoanId, newTerms, msg.sender, lender, amounts, repayAmount);
        } else {
            _repayLoan(msg.sender, IERC20(newTerms.payableCurrency), oldLoanId, repayAmount);

            if (amounts.amountToBorrower > 0) {
                // If new principal is greater than old loan repayment amount, send the difference to the borrower
                IERC20(newTerms.payableCurrency).safeTransfer(msg.sender, amounts.amountToBorrower);
            }
        }

        // initialize v4 loan
        _initializeMigrationLoan(newTerms, msg.sender, lender, feeSnapshot);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationConfiguration.runPredicatesCheck(msg.sender, lender, newTerms, itemPredicates);
    }

    // =================================== MIGRATION VALIDATION =========================================

    /**
     * @notice Validates that the migration is valid. If any of these conditionals are not met
     *         the transaction will revert.
     *
     * @dev All whitelisted payable currencies and collateral state on v3 must also be set to the
     *      same values on v4.
     *
     * @param sourceLoanTerms           The terms of the V3 loan.
     * @param newLoanTerms              The terms of the V4 loan.
     * @param borrowerNoteId            The ID of the borrowerNote for the old loan.
     */
    function _validateV3Migration(
        LoanLibraryV3.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms memory newLoanTerms,
        uint256 borrowerNoteId
    ) internal view {
        // ------------- Caller Validation -------------
        address _borrower = IPromissoryNote(borrowerNoteV3).ownerOf(borrowerNoteId);

        if (_borrower != msg.sender) revert OCM_CallerNotBorrower();

        // ------------- Migration Terms Validation -------------
        // currency must be the same
        if (sourceLoanTerms.payableCurrency != newLoanTerms.payableCurrency) {
            revert OCM_CurrencyMismatch(sourceLoanTerms.payableCurrency, newLoanTerms.payableCurrency);
        }

        // collateral address and id must be the same
        if (sourceLoanTerms.collateralAddress != newLoanTerms.collateralAddress || sourceLoanTerms.collateralId != newLoanTerms.collateralId) {
            revert OCM_CollateralMismatch(
                sourceLoanTerms.collateralAddress,
                sourceLoanTerms.collateralId,
                newLoanTerms.collateralAddress,
                newLoanTerms.collateralId
            );
        }

        // ------------- New LoanTerms Validation -------------
        // Any collateral or currencies that is whitelisted on v3 also needs to be whitelisted on v4
        originationConfiguration.validateLoanTerms(newLoanTerms);
    }

    // ========================================= HELPERS ================================================

    /**
     * @notice Helper function to distribute funds based on the migration amounts. If the lender is the
     *         same as the old lender, the flash loan trigger is set to true. This informs the calling
     *         function that a flash loan must be initiated to repay the old loan.
     *
     * @param oldLoanId                 The ID of the v3 loan to be migrated.
     * @param oldLoanData               The loan data of the v3 loan.
     * @param newPrincipalAmount        The principal amount of the new loan.
     * @param borrower_                 The address of the borrower.
     * @param lender                    The address of the new lender.
     *
     * @return amounts                  The migration amounts.
     * @return feeSnapshot              A snapshot of current lending fees.
     * @return repayAmount              The amount needed to repay the old loan.
     * @return flashLoanTrigger         boolean indicating if a flash loan must be initiated.
     */
    function _migrate(
        uint256 oldLoanId,
        LoanLibraryV3.LoanData memory oldLoanData,
        uint256 newPrincipalAmount,
        address borrower_,
        address lender
    ) internal nonReentrant returns (
        OriginationLibrary.RolloverAmounts memory amounts,
        LoanLibrary.FeeSnapshot memory feeSnapshot,
        uint256 repayAmount,
        bool flashLoanTrigger
    ) {
        address oldLender = ILoanCoreV3(loanCoreV3).lenderNote().ownerOf(oldLoanId);
        IERC20 payableCurrency = IERC20(oldLoanData.terms.payableCurrency);

        // get fee snapshot from fee controller
        (feeSnapshot) = feeController.getFeeSnapshot();

        // Calculate settle amounts
        (amounts, repayAmount) = _calculateV3MigrationAmounts(
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
            if (amounts.leftoverPrincipal > 0) {
                payableCurrency.safeTransferFrom(lender, address(this), amounts.leftoverPrincipal);
            }
        }

        if (amounts.needFromBorrower > 0) {
            // Borrower owes from old loan
            payableCurrency.safeTransferFrom(borrower_, address(this), amounts.needFromBorrower);
        }
    }

    /**
     * @notice Helper function to calculate the amounts needed to settle the old loan.
     *
     * @dev When calling OriginationCalculator.rolloverAmounts, the first param is the v3
     *      loan principal not balance, since V3 is not pro-rata.
     *
     * @param oldLoanData               The terms of the v3 loan.
     * @param newPrincipalAmount        The principal amount of the new loan.
     * @param lender                    The address of the new lender.
     * @param oldLender                 The address of the old lender.
     *
     * @return amounts                  The migration amounts.
     * @return repayAmount              The amount needed to repay the v3 loan.
     */
    function _calculateV3MigrationAmounts(
        LoanLibraryV3.LoanData memory oldLoanData,
        uint256 newPrincipalAmount,
        address lender,
        address oldLender
    ) internal view returns (OriginationLibrary.RolloverAmounts memory amounts, uint256 repayAmount) {
        // get total interest to close v3 loan
        uint256 interest = IRepaymentControllerV3(repaymentControllerV3).getInterestAmount(
            oldLoanData.terms.principal,
            oldLoanData.terms.proratedInterestRate
        );

        // calculate the repay amount to settle V3 loan
        repayAmount = oldLoanData.terms.principal + interest;

        amounts = rolloverAmounts(
            oldLoanData.terms.principal,
            interest,
            newPrincipalAmount,
            lender,
            oldLender,
            0,
            0
        );
    }

    // ======================================= FLASH LOAN OPS ===========================================

    /**
     * @notice Helper function to initiate a flash loan. The flash loan amount is the total amount
     *         needed to repay the old loan.
     *
     * @param oldLoanId                 The ID of the v3 loan to be migrated.
     * @param newLoanTerms              The terms of the v4 loan.
     * @param borrower_                 The address of the borrower.
     * @param lender                    The address of the new lender.
     * @param _amounts                  The migration amounts.
     * @param repayAmount               The flash loan amount.
     */
    function _initiateFlashLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms memory newLoanTerms,
        address borrower_,
        address lender,
        OriginationLibrary.RolloverAmounts memory _amounts,
        uint256 repayAmount
    ) internal {
        // cache borrower address for flash loan callback
        borrower = borrower_;

        IERC20[] memory assets = new IERC20[](1);
        assets[0] = IERC20(newLoanTerms.payableCurrency);

        // flash loan amount = new principal + any difference supplied by borrower
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = repayAmount;

        bytes memory params = abi.encode(
            OriginationLibrary.OperationData(
                {
                    oldLoanId: oldLoanId,
                    newLoanTerms: newLoanTerms,
                    borrower: borrower_,
                    lender: lender,
                    migrationAmounts: _amounts
                }
            )
        );

        // Flash loan based on principal + interest
        IVault(VAULT).flashLoan(this, assets, amounts, params);

        // reset borrower state
        borrower = address(0);
    }

    /**
     * @notice Callback function for flash loan. OpData is decoded and used to execute the migration.
     *
     * @dev The caller of this function must be the lending pool.
     * @dev This function checks that the borrower is cached and that the opData borrower matches the
     *      borrower cached in the flash loan callback.
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
        if (msg.sender != VAULT) revert OCM_UnknownCaller(msg.sender, VAULT);

        OriginationLibrary.OperationData memory opData = abi.decode(params, (OriginationLibrary.OperationData));

        // verify this contract started the flash loan
        if (opData.borrower != borrower) revert OCM_UnknownBorrower(opData.borrower, borrower);
        // borrower must be set
        if (borrower == address(0)) revert OCM_BorrowerNotCached();

        _executeOperation(assets, amounts, feeAmounts, opData);
    }

    /**
     * @notice Executes repayment of v3 loan and initialization of new v4 loan. Any funds
     *         that are not covered by closing out the old loan must be covered by the borrower.
     *
     * @param assets                 The ERC20 address that was borrowed in flash Loan.
     * @param amounts                The amount that was borrowed in flash Loan.
     * @param premiums               The fees that are due to the flash loan pool.
     * @param opData                 The data to be executed after receiving flash Loan.
     */
    function _executeOperation(
        IERC20[] calldata assets,
        uint256[] calldata amounts,
        uint256[] memory premiums,
        OriginationLibrary.OperationData memory opData
    ) internal {
        IERC20 asset = assets[0];

        _repayLoan(borrower, asset, opData.oldLoanId, amounts[0]);

        // pull funds from the lender to repay the flash loan
        IERC20(opData.newLoanTerms.payableCurrency).safeTransferFrom(
            opData.lender,
            address(this),
            // amount = v3 repayment amount - leftover principal + flash loan fee
            opData.migrationAmounts.amountFromLender - opData.migrationAmounts.leftoverPrincipal + premiums[0]
        );

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
     * @param _borrower                    The address of the borrower.
     * @param payableCurrency              Payable currency for the loan terms.
     * @param borrowerNoteId               ID of the borrowerNote for the loan to be repaid.
     * @param repayAmount                  The amount to be repaid on V3
     */
    function _repayLoan(
        address _borrower,
        IERC20 payableCurrency,
        uint256 borrowerNoteId,
        uint256 repayAmount
    ) internal {
        // pull BorrowerNote from the caller so that this contract receives collateral upon V3 repayment
        // borrower must approve this withdrawal
        IPromissoryNote(borrowerNoteV3).transferFrom(_borrower, address(this), borrowerNoteId);

        // approve LoanCoreV3 to take the total settled amount
        payableCurrency.safeApprove(loanCoreV3, repayAmount);

        // repay V3 loan, this contract receives the collateral
        IRepaymentControllerV3(repaymentControllerV3).repay(borrowerNoteId);
    }

    /**
     * @notice Helper function to initialize the new v4 loan.
     *
     * @param newTerms                  The terms of the v4 loan.
     * @param borrower_                 The address of the borrower.
     * @param lender                    The address of the lender.
     * @param feeSnapshot               The fee snapshot for the loan.
     *
     * @return newLoanId                The ID of the new loan.
     */
    function _initializeMigrationLoan(
        LoanLibrary.LoanTerms memory newTerms,
        address borrower_,
        address lender,
        LoanLibrary.FeeSnapshot memory feeSnapshot
    ) internal returns (uint256 newLoanId) {
        // transfer collateral to LoanCore
        IERC721(newTerms.collateralAddress).transferFrom(address(this), address(loanCore), newTerms.collateralId);

        // create loan in LoanCore
        newLoanId = loanCore.startLoan(lender, borrower_, newTerms, feeSnapshot);

        emit V3V4Rollover(lender, borrower_, newTerms.collateralId, newLoanId);
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
    function pause(bool _pause) external override onlyRole(MIGRATION_MANAGER_ROLE) {
        if (paused == _pause) revert OCM_StateAlreadySet();

        paused = _pause;

        emit PausedStateChanged(_pause);
    }

    /**
     * @notice This function ensures that at the start of every flash loan sequence, the borrower
     *         state is reset to address(0). The migration function that inherits this modifier sets
     *         the borrower state before executing the flash loan and resets it to zero after the
     *         flash loan has been executed.
     */
    modifier whenBorrowerReset() {
        if (borrower != address(0)) revert OCM_BorrowerNotReset(borrower);

        _;
    }

    /**
     * @notice This modifier ensures the migration functionality is not paused.
     */
    modifier whenNotPaused() {
        if (paused) revert OCM_Paused();

        _;
    }
}