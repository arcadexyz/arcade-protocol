// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

import "../origination/OriginationControllerBase.sol";

import "../interfaces/ICrossCurrencyRollover.sol";
import "../interfaces/ILoanCore.sol";
import "../interfaces/IRepaymentController.sol";

import "../libraries/LoanLibrary.sol";
import "../libraries/InterestCalculator.sol";
import "../libraries/FeeLookups.sol";

import {
    CCR_StateAlreadySet,
    CCR_Paused,
    CCR_InvalidState,
    CCR_SideMismatch,
    CCR_SameCurrency,
    CCR_CollateralMismatch,
    CCR_LenderIsBorrower,
    CCR_CallerNotBorrower,
    CCR_ZeroAddress
} from "../errors/Lending.sol";

contract CrossCurrencyRollover is
    ICrossCurrencyRollover,
    OriginationControllerBase,
    FeeLookups,
    AccessControlEnumerable,
    ReentrancyGuard,
    ERC721Holder {
    using SafeERC20 for IERC20;

    // ============================================ STATE ==============================================
    // ============== Constants ==============
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN");
    bytes32 public constant ROLLOVER_MANAGER_ROLE = keccak256("ROLLOVER_MANAGER");

    // ============ Global State =============
    ISwapRouter public immutable swapRouter;

    /// @notice lending protocol
    address private immutable borrowerNote;
    address private immutable repaymentController;

    /// @notice state variable for pausing the contract
    bool public paused;

    constructor(
        address _originationHelpers,
        address _loanCore,
        address _borrowerNote,
        address _repaymentController,
        ISwapRouter _swapRouter
    ) OriginationControllerBase(_originationHelpers, _loanCore) {
        if (address(_borrowerNote) == address(0)) revert CCR_ZeroAddress("borrowerNote");
        if (address(_repaymentController) == address(0)) revert CCR_ZeroAddress("repaymentController");
        if (address(_swapRouter) == address(0)) revert CCR_ZeroAddress("swapRouter");

        _setupRole(ADMIN_ROLE, msg.sender);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);

        _setupRole(ROLLOVER_MANAGER_ROLE, msg.sender);
        _setRoleAdmin(ROLLOVER_MANAGER_ROLE, ADMIN_ROLE);

        borrowerNote = _borrowerNote;
        repaymentController = _repaymentController;
        swapRouter = _swapRouter;
    }

    // ====================================== CURRENCY MIGRATION ============================================
    /**
     * @notice Roll over an active loan from one currency to another. This function validates new
     *         loan terms against the old terms and then executes the rollover.
     *
     * @dev This function is only callable by the borrower of the loan.
     * @dev This function is only callable when the rollover flow is not paused.
     *      In order for the old loan to be repaid, the new lender must have approved this contract
     *      to pull the total amount needed to repay the loan.
     *
     * @param oldLoanId                 The ID of the original loan to be migrated.
     * @param newTerms                  The terms of the new loan.
     * @param lender                    The address of the new lender.
     * @param sig                       The signature of the loan terms.
     * @param sigProperties             The properties of the signature.
     * @param itemPredicates            The predicates for the loan.
     * @param swapParams                The fee tier and slippage tolerance for the
     *                                  currency swap.
     */
    function rolloverCrossCurrencyLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata newTerms,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates,
        SwapParameters calldata swapParams
    ) external override whenNotPaused {
        LoanLibrary.LoanData memory oldLoanData = ILoanCore(loanCore).getLoan(oldLoanId);

        // ------------ Rollover Validation ------------
        if (oldLoanData.state != LoanLibrary.LoanState.Active) revert CCR_InvalidState(uint8(oldLoanData.state));

        _validateCurrencyRollover(oldLoanData.terms, newTerms, oldLoanId);

        (bytes32 sighash, address externalSigner) = _recoverSignature(newTerms, sig, sigProperties, Side.LEND, lender, itemPredicates);

        // counterparty validation
        if (!isSelfOrApproved(lender, externalSigner) && !OriginationLibrary.isApprovedForContract(lender, sig, sighash)) {
            revert CCR_SideMismatch(externalSigner);
        }

        // new lender cannot be the same as the borrower
        if (msg.sender == lender) revert CCR_LenderIsBorrower();

        // consume new loan nonce
        loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);

        _executeRollover(oldLoanId, oldLoanData, lender, newTerms, swapParams);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationHelpers.runPredicatesCheck(msg.sender, lender, newTerms, itemPredicates);
    }

    // =================================== ROLLOVER VALIDATION =========================================
    /**
     * @notice Validates that the rollover is valid. If any of these conditionals are not met
     *         the transaction will revert.
     *
     * @param sourceLoanTerms           The terms of the original loan.
     * @param newLoanTerms              The terms of the new loan.
     * @param borrowerNoteId            The ID of the borrowerNote for the old loan.
     */
    function _validateCurrencyRollover(
        LoanLibrary.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms memory newLoanTerms,
        uint256 borrowerNoteId
    ) internal view {
        // ------------- Caller Validation -------------
        address borrower = IPromissoryNote(borrowerNote).ownerOf(borrowerNoteId);

        if (borrower != msg.sender) revert CCR_CallerNotBorrower();

        // ------------- Rollover Terms Validation -------------
        // currency must not be the same
        if (sourceLoanTerms.payableCurrency == newLoanTerms.payableCurrency) {
            revert CCR_SameCurrency(sourceLoanTerms.payableCurrency, newLoanTerms.payableCurrency);
        }

        // collateral address and id must be the same
        if (sourceLoanTerms.collateralAddress != newLoanTerms.collateralAddress || sourceLoanTerms.collateralId != newLoanTerms.collateralId) {
            revert CCR_CollateralMismatch(
                sourceLoanTerms.collateralAddress,
                sourceLoanTerms.collateralId,
                newLoanTerms.collateralAddress,
                newLoanTerms.collateralId
            );
        }

        // ------------- New LoanTerms Validation -------------
        originationHelpers.validateLoanTerms(newLoanTerms);
    }

    // ========================================= HELPERS ================================================
    /**
     * @notice Executes the rollover of a loan from one set of terms to another.
     *         Handles the settlement of old loan amounts and the necessary funds transfer
     *         to repay the old loan and initialize the new loan.
     *
     * @param oldLoanId                  The ID of the original loan to be rolled over.
     * @param oldLoanData                The loan data of the original loan.
     * @param lender                     The address of the new loan lender.
     * @param newLoanTerms               The terms of the new loan.
     * @param swapParams                 The parameters for the currency swap.
     */
    function _executeRollover(
        uint256 oldLoanId,
        LoanLibrary.LoanData memory oldLoanData,
        address lender,
        LoanLibrary.LoanTerms memory newLoanTerms,
        SwapParameters memory swapParams
    ) internal {
        // get funds for new loan and swap them
        uint256 repayAmount = _processSettlement(
            msg.sender,
            lender,
            swapParams,
            newLoanTerms,
            oldLoanData,
            oldLoanId
        );

        // repay old loan
        _repayLoan(msg.sender, IERC20(oldLoanData.terms.payableCurrency), oldLoanId, repayAmount);

        // initialize new loan
        _initializeRolloverLoan(newLoanTerms, msg.sender, lender, oldLoanData);
    }

    /**
     * @notice Initializes the new loan.
     *
     * @param newTerms                  The terms of the new loan.
     * @param borrower                  The address of the borrower.
     * @param lender                    The address of the lender.
     * @param oldLoanData               The loan data of the original loan.
     *
     * @return newLoanId                The ID of the new loan.
     */
    function _initializeRolloverLoan(
        LoanLibrary.LoanTerms memory newTerms,
        address borrower,
        address lender,
        LoanLibrary.LoanData memory oldLoanData
    ) internal nonReentrant returns (uint256 newLoanId) {
        LoanLibrary.FeeSnapshot memory feeSnapshot;

        // transfer collateral to LoanCore
        IERC721(newTerms.collateralAddress).transferFrom(address(this), address(loanCore), newTerms.collateralId);

        feeSnapshot.lenderInterestFee = oldLoanData.lenderInterestFee;
        feeSnapshot.lenderPrincipalFee = oldLoanData.lenderPrincipalFee;

        // create loan in LoanCore
        newLoanId = loanCore.startLoan(lender, borrower, newTerms, feeSnapshot);

        emit CurrencyRollover(lender, borrower, newTerms.collateralId, newLoanId);
    }

    /**
     * @notice swapExactInputSingle swaps a fixed amount of tokenIn for a maximum possible amount of
     *         tokenOut by calling `exactInputSingle` in the Uniswap swap router.
     *         SwapRouter's exactInputSingle function reverts if amountOut < amountOutMinimum.
     *
     * @dev The calling address must approve this contract to spend at least amountIn worth of tokenIn.
     *
     * @param tokenIn                   Address of the token being swapped.
     * @param tokenOut                  Address of the token to be received.
     * @param amountIn                  The exact amount of tokenIn that will be swapped for tokenOut.
     * @param amountOutMinimum          Minimum amount of tokenOut expected. Helps protect against
     *                                  front running, sandwich or another type of price manipulation.
     * @param fee                       The fee tier of the pool. Determines the pool contract in
     *                                  which to execute the swap.
     *
     * @return amountOut                The amount of tokenOut received.
     */
    function _swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        // approve the UniswapV3 router to spend tokenIn
        IERC20(tokenIn).safeApprove(address(swapRouter), amountIn);

        // setting sqrtPriceLimitX96 to zero makes the parameter inactive.
        // This parameter sets a boundary on the pool's swap price. It defines the
        // worst acceptable price before the transaction reverts to allow for partial
        // swaps, hence the value here is zero as we do not want to accept partial
        // swaps.
        ISwapRouter.ExactInputSingleParams memory params =
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            });

        // execute the swap
        amountOut = swapRouter.exactInputSingle(params);
    }

    /**
     * @notice Collects payment funds and performs currency swap for cross-currency loan repayment.
     *         Any funds that are not covered by closing out the old loan must be covered by
     *         the borrower.  Any excess funds are sent to the borrower.
     *
     * @param borrower               The address of the borrower.
     *                               executing the repayment and swap.
     * @param lender                 The address of the new lender.
     * @param swapParams             The parameters for the currency swap.
     * @param newLoanTerms           The terms of the new loan.
     * @param oldLoanData            The loan data of the original loan.
     * @param oldLoanId              The ID of the original loan to be rolled over.
     *
     * @return repayAmount           The amount to be repaid to the old loan.
     */
    function _processSettlement(
        address borrower,
        address lender,
        SwapParameters memory swapParams,
        LoanLibrary.LoanTerms memory newLoanTerms,
        LoanLibrary.LoanData memory oldLoanData,
        uint256 oldLoanId
    ) internal nonReentrant returns (uint256 repayAmount) {
        // pull funds from the new lender
        IERC20(newLoanTerms.payableCurrency).safeTransferFrom(
            lender,
            address(this),
            newLoanTerms.principal
        );

        // swap the new lender payment from new currency to the original currency
        // the swap will revert if swappedAmount < minAmountOut
        uint256 swappedAmount = _swapExactInputSingle(
            newLoanTerms.payableCurrency,
            oldLoanData.terms.payableCurrency,
            newLoanTerms.principal,
            swapParams.minAmountOut,
            swapParams.poolFeeTier
        );

        address oldLender = ILoanCore(loanCore).lenderNote().ownerOf(oldLoanId);

        // get interest amount due
        uint256 interestAmount = InterestCalculator.getProratedInterestAmount(
            oldLoanData.balance,
            oldLoanData.terms.interestRate,
            oldLoanData.terms.durationSecs,
            oldLoanData.startDate,
            oldLoanData.lastAccrualTimestamp,
            block.timestamp
        );

        // calculate the repay amount to settle the original loan
        repayAmount = oldLoanData.terms.principal + interestAmount;

        OriginationLibrary.RolloverAmounts memory amounts = rolloverAmounts(
            oldLoanData.terms.principal,
            interestAmount,
            swappedAmount,
            lender,
            oldLender,
            oldLoanData.lenderInterestFee,
            oldLoanData.lenderPrincipalFee
        );

        // borrower owes
        if (amounts.needFromBorrower > 0) {
            IERC20(oldLoanData.terms.payableCurrency).safeTransferFrom(borrower, address(this), amounts.needFromBorrower);
        } else if (amounts.amountToBorrower > 0) {
            // borrower gets more
            IERC20(oldLoanData.terms.payableCurrency).safeTransfer(borrower, amounts.amountToBorrower);
        }
    }

    /**
     * @notice Repays the original loan.
     *
     * @param borrower                     The address of the borrower.
     * @param payableCurrency              Payable currency for the loan terms.
     * @param borrowerNoteId               ID of the borrowerNote for the loan to be repaid.
     * @param repayAmount                  The amount to be repaid to the old loan.
     */
    function _repayLoan(
        address borrower,
        IERC20 payableCurrency,
        uint256 borrowerNoteId,
        uint256 repayAmount
    ) internal nonReentrant {
        // pull BorrowerNote from the caller so that this contract receives collateral upon original loan repayment
        // borrower must approve this withdrawal
        IPromissoryNote(borrowerNote).transferFrom(borrower, address(this), borrowerNoteId);

        // approve LoanCore to take the total settled amount
        payableCurrency.safeApprove(address(loanCore), repayAmount);

        // repay original currency loan, this contract receives the collateral
        IRepaymentController(repaymentController).repayFull(borrowerNoteId);
    }

    // ========================================== ADMIN =================================================
    /**
     * @notice Function to be used by the contract owner to pause the contract.
     *
     * @dev This function is only to be used if a vulnerability is found in the
     *      currency rollover flow.
     *
     * @param _pause              The state to set the contract to.
     */
    function pause(bool _pause) external override onlyRole(ROLLOVER_MANAGER_ROLE) {
        if (paused == _pause) revert CCR_StateAlreadySet();

        paused = _pause;

        emit PausedStateChanged(_pause);
    }

    /**
     * @notice This modifier ensures the rollover functionality is not paused.
     */
    modifier whenNotPaused() {
        if (paused) revert CCR_Paused();

        _;
    }
}