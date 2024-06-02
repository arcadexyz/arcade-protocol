// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

import "solady/src/utils/FixedPointMathLib.sol";

import "../origination/OriginationController.sol";

import "../interfaces/ICrossCurrencyRollover.sol";
import "../interfaces/ILoanCore.sol";
import "../interfaces/IRepaymentController.sol";
import "../libraries/LoanLibrary.sol";
import "../libraries/InterestCalculator.sol";

import "../external/uniswapV3/libraries/PoolAddress.sol";

import {
    CCR_UnknownBorrower,
    CCR_UnknownCaller,
    CCR_BorrowerNotCached,
    CCR_BorrowerNotReset,
    CCR_StateAlreadySet,
    CCR_Paused,
    CCR_InvalidState,
    CCR_SideMismatch,
    CCR_SameCurrency,
    CCR_CollateralMismatch,
    CCR_LenderIsBorrower,
    CCR_CallerNotBorrower,
    CCR_ZeroAddress
} from "../errors/Rollover.sol";

contract CrossCurrencyRollover is ICrossCurrencyRollover, OriginationController, ERC721Holder {
    using SafeERC20 for IERC20;

    // ============================================ STATE ==============================================
    // ============== Constants ==============
    uint256 public constant ONE = 1e18;

    /// @notice UniswapV3Factory
    address private constant POOL_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;

    // ============ Global State =============
    ISwapRouter public immutable swapRouter;

    /// @notice lending protocol
    address private immutable borrowerNote;
    address private immutable repaymentController;

    /// @notice Borrower address is cached and checked against the
    ///         repayment data.
    address private borrower;

    /// @notice state variable for pausing the contract
    bool public paused;

    constructor(
        address _originationHelpers,
        address _loanCore,
        address _borrowerNote,
        address _repaymentController,
        address _feeController,
        ISwapRouter _swapRouter
    ) OriginationController(_originationHelpers, _loanCore, _feeController) {
        if (address(_borrowerNote) == address(0)) revert CCR_ZeroAddress("borrowerNote");
        if (address(_repaymentController) == address(0)) revert CCR_ZeroAddress("repaymentController");
        if (address(_swapRouter) == address(0)) revert CCR_ZeroAddress("swapRouter");

        borrowerNote = _borrowerNote;
        repaymentController = _repaymentController;
        swapRouter = _swapRouter;
    }

    // ======================================= Currency MIGRATION =============================================
    /**
     * @notice Migrate an active loan on from one currency to another. This function validates new loan
     *         terms against the old terms. It calculates the amounts needed to settle the old loan, and
     *         then executes the rollover.
     *
     * @dev This function is only callable by the borrower of the loan.
     * @dev This function is only callable when the rollover flow is not paused.
     *      In order for the old loan to be repaid, the new lender must have approved this contract to
     *      pull the total amount needed to repay the loan.
     *
     * @param oldLoanId                 The ID of the original loan to be migrated.
     * @param newTerms                  The terms of the new loan.
     * @param lender                    The address of the new lender.
     * @param sig                       The signature of the loan terms.
     * @param sigProperties             The properties of the signature.
     * @param itemPredicates            The predicates for the loan.
     */
    function rolloverCrossCurrencyLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata newTerms,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates,
        OriginationLibrary.SwapParameters calldata swapParams
    ) external override whenNotPaused whenBorrowerReset {
        LoanLibrary.LoanData memory oldLoanData = ILoanCore(loanCore).getLoan(oldLoanId);

        // ------------ Rollover Validation ------------
        if (oldLoanData.state != LoanLibrary.LoanState.Active) revert CCR_InvalidState(uint8(oldLoanData.state));

        _validateCurrencyRollover(oldLoanData.terms, newTerms, oldLoanId);

        {
            (bytes32 sighash, address externalSigner) = _recoverSignature(newTerms, sig, sigProperties, Side.LEND, lender, itemPredicates);

            // counterparty validation
            if (!isSelfOrApproved(lender, externalSigner) && !OriginationLibrary.isApprovedForContract(lender, sig, sighash)) {
                revert CCR_SideMismatch(externalSigner);
            }

            // new lender cannot be the same as the borrower
            if (msg.sender == lender) revert CCR_LenderIsBorrower();

            // consume new loan nonce
            loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);
        }

        // ------------ Rollover Execution ------------
        // collect and distribute settled amounts

        (
            OriginationLibrary.RolloverAmounts memory amounts,
            LoanLibrary.FeeSnapshot memory feeSnapshot,
            uint256 repayAmount
        ) = _rollover(oldLoanId, oldLoanData, newTerms.principal, newTerms.payableCurrency, msg.sender, lender, swapParams.poolFeeTier);

        // get and swap new currency funds and repay old loan
        _initiateRepayment(oldLoanId, msg.sender, lender, oldLoanData.terms.payableCurrency, newTerms, amounts, repayAmount, swapParams);

        // initialize new loan
        _initializeRolloverLoan(newTerms, msg.sender, lender, feeSnapshot);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationHelpers.runPredicatesCheck(msg.sender, lender, newTerms, itemPredicates);
    }

    /**
     * @notice Gets the current price of tokenIn in terms of tokenOut from a specified
     *         UniswapV3 pool.
     *
     * @dev This function computes the price based on the pool's returned square root price.
     *      It also adjusts for token decimals and ensures that the price correlates with the
     *      correct token direction.
     *      If tokenIn is not the native token of the pool, i.e., token0, the price is inverted.
     *
     * @param tokenIn                    The address of the input token.
     * @param tokenOut                   The address of the output token / the token we want
     *                                   to receive.
     * @param poolFee                    The pool's fee tier, used to locate the correct pool.
     *
     * @return price                     The price of one unit of tokenIn expressed in units
     *                                   of tokenOut.
     */
    function fetchCurrentPrice(address tokenIn, address tokenOut, uint24 poolFee) public view returns (uint256 price) {
        PoolAddress.PoolKey memory poolKey = PoolAddress.getPoolKey(tokenIn, tokenOut, poolFee);
        // get the pool address
        address pool = PoolAddress.computeAddress(POOL_FACTORY, poolKey);
        IUniswapV3Pool uniswapPool = IUniswapV3Pool(pool);

        // price is stored as the square root of the ratio of the two tokens, and its value is
        // encoded in a fixed-point format Q64.96.
        (uint160 sqrtPriceX96,,,,,,) = uniswapPool.slot0();

        // square the sqrtPriceX96 to revert to the non-root price
        uint256 basePrice = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        // multiply by scaleFactor and divide by 2^192 because basePrice is multiplying two 96-bit numbers
        basePrice = FixedPointMathLib.mulDiv(basePrice, ONE, uint256(1) << 192);

        // get the decimal places for both tokenIn and tokenOut. Needed for adjusting the price
        // based on how many decimal places each token uses
        uint8 decimalsTokenIn = IERC20Metadata(tokenIn).decimals();
        uint8 decimalsTokenOut = IERC20Metadata(tokenOut).decimals();

        // adjusts the basePrice depending on the difference in decimals between tokenIn and tokenOut.
        // If tokenIn has more decimals than tokenOut, the price is scaled up because each unit of
        // tokenIn represents a smaller amount of value than one unit of tokenOut.
        // If tokenOut has more decimals, the price is scaled down.
        // Otherwise no scaling is needed.
        if (decimalsTokenIn > decimalsTokenOut) {
            price = basePrice * (10 ** (decimalsTokenIn - decimalsTokenOut));
        } else if (decimalsTokenOut > decimalsTokenIn) {
            uint256 divisionFactor = 10 ** (decimalsTokenOut - decimalsTokenIn);
            price = FixedPointMathLib.mulDiv(basePrice, 1, divisionFactor);
        } else {
            price = basePrice;
        }

        // in UniswapV3 pools the determination of which token is token0 and which is token1
        // is based on the tokens' Ethereum addresses: the token with the lower address becomes
        // token0, and the higher address becomes token1.
        // if function args tokenIn is not token0, the price needs to be inverted
        // to reflect the cost of tokenIn in terms of tokenOut.
        address token0 = tokenIn < tokenOut ? tokenIn : tokenOut;
        if (tokenIn != token0) {
            // if tokenIn is not the base token, invert the price
            price = type(uint256).max / (price > 0 ? price : 1);
        }

        return price;
    }

    // =================================== ROLLOVER VALIDATION =========================================
    /**
     * @notice Validates that the rollover is valid. If any of these conditionals are not met
     *         the transaction will revert.
     *
     * @dev All whitelisted payable currencies and collateral must be whitelisted.
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
        address _borrower = IPromissoryNote(borrowerNote).ownerOf(borrowerNoteId);

        if (_borrower != msg.sender) revert CCR_CallerNotBorrower();

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
     * @notice Helper function to distribute funds based on the rollover amounts.
     *
     * @param oldLoanId                 The ID of the original loan to be rolled over.
     * @param oldLoanData               The loan data of the original loan.
     * @param newPrincipalAmount        The principal amount of the new loan.
     * @param newCurrency               The currency of the new loan.
     * @param borrower_                 The address of the borrower.
     * @param lender                    The address of the new lender.
     *
     * @return amounts                  The rollover amounts.
     * @return feeSnapshot              A snapshot of current lending fees.
     * @return repayAmount              The amount needed to repay the old loan.
     */
    function _rollover(
        uint256 oldLoanId,
        LoanLibrary.LoanData memory oldLoanData,
        uint256 newPrincipalAmount,
        address newCurrency,
        address borrower_,
        address lender,
        uint24 poolFee
    ) internal nonReentrant returns (
        OriginationLibrary.RolloverAmounts memory amounts,
        LoanLibrary.FeeSnapshot memory feeSnapshot,
        uint256 repayAmount
    ) {
        address oldLender = ILoanCore(loanCore).lenderNote().ownerOf(oldLoanId);
        IERC20 payableCurrency = IERC20(oldLoanData.terms.payableCurrency);

        // get fee snapshot from fee controller
        (feeSnapshot) = feeController.getFeeSnapshot();

        // Calculate settle amounts
        (amounts, repayAmount) = _calculateCurrencyRolloverAmounts(
            oldLoanData,
            newPrincipalAmount,
            newCurrency,
            lender,
            oldLender,
            poolFee
        );

        if (amounts.needFromBorrower > 0) {
            // Borrower owes from old loan
            payableCurrency.safeTransferFrom(borrower_, address(this), amounts.needFromBorrower);
        }
    }

    /**
     * @notice Helper function to calculate the amounts needed to settle the old loan.
     *
     * @param oldLoanData               The terms of the original loan.
     * @param newPrincipalAmount        The principal amount of the new loan.
     * @param newCurrency               The currency of the new loan.
     * @param lender                    The address of the new lender.
     * @param oldLender                 The address of the old lender.
     * @param poolFee                   The fee tier of the pool.
     *
     * @return amounts                  The rollover amounts.
     * @return repayAmount              The amount needed to repay the original loan.
     */
    function _calculateCurrencyRolloverAmounts(
        LoanLibrary.LoanData memory oldLoanData,
        uint256 newPrincipalAmount,
        address newCurrency,
        address lender,
        address oldLender,
        uint24 poolFee
    ) internal returns (OriginationLibrary.RolloverAmounts memory amounts, uint256 repayAmount) {
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

        uint256 price = fetchCurrentPrice(oldLoanData.terms.payableCurrency, newCurrency, poolFee);
        uint256 newCurrencyPrincipal = (newPrincipalAmount * ONE) / price;

        amounts = rolloverAmounts(
            oldLoanData.terms.principal,
            interestAmount,
            newCurrencyPrincipal,
            lender,
            oldLender,
            0,
            0
        );
    }

    /**
     * @notice Calculates the prorated interest amount for a loan based on the current
     *         time and the loan data.
     *
     * @param loanId                    The ID of the loan for which to calculate the
     *                                  prorated interest amount.
     *
     * @return interestAmount           The amount of prorated interest that has accrued
     *                                  on the loan.
     *
     */
    function calculateProratedInterestAmount(uint256 loanId) external view returns (uint256) {
        uint256 currentTimestamp = block.timestamp;
        LoanLibrary.LoanData memory data = loanCore.getLoan(loanId);

        uint256 interestAmount = InterestCalculator.getProratedInterestAmount(
            data.balance,
            data.terms.interestRate,
            data.terms.durationSecs,
            data.startDate,
            data.lastAccrualTimestamp,
            currentTimestamp
        );

        return interestAmount;
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
    function _initializeRolloverLoan(
        LoanLibrary.LoanTerms memory newTerms,
        address borrower_,
        address lender,
        LoanLibrary.FeeSnapshot memory feeSnapshot
    ) internal returns (uint256 newLoanId) {
        // transfer collateral to LoanCore
        IERC721(newTerms.collateralAddress).transferFrom(address(this), address(loanCore), newTerms.collateralId);

        // create loan in LoanCore
        newLoanId = loanCore.startLoan(lender, borrower_, newTerms, feeSnapshot);

        emit CurrencyRollover(lender, borrower_, newTerms.collateralId, newLoanId);
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
     * @param recipient                 Address receiving the output token
     *
     * @return amountOut                The amount of tokenOut received.
     */
    function _swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint24 fee,
        address recipient
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
                recipient: recipient,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            });

        // execute the swap
        amountOut = swapRouter.exactInputSingle(params);
    }

    // ======================================= LOAN REPAYMENT ===========================================
    /**
     * @notice This function sets up the old loan repayment data and triggers the repayment swap process
     *         for the necessary funds to be collected from the new lender and swapped to the original
     *         loan currency before being applied towards the repayment of the old loan.
     *
     * @param oldLoanId                 The ID of the original loan to be migrated.
     * @param borrower_                 The address of the borrower.
     * @param lender                    The address of the new lender.
     * @param oldLoanCurrency           The currency of the old loan.
     * @param newLoanTerms              The terms of the new currency loan.
     * @param _amounts                  The rollover amounts.
     * @param repayAmount               The principal and interest owed on the old loan.
     * @param swapParams                Parameters for the currency swap, including
     *                                  minimum swap amount out and pool fee tier.
     */
    function _initiateRepayment(
        uint256 oldLoanId,
        address borrower_,
        address lender,
        address oldLoanCurrency,
        LoanLibrary.LoanTerms memory newLoanTerms,
        OriginationLibrary.RolloverAmounts memory _amounts,
        uint256 repayAmount,
        OriginationLibrary.SwapParameters memory swapParams
    ) internal {
        // cache borrower address
        borrower = borrower_;

        // create repayment data
        OriginationLibrary.CrossCurrencyRepayData memory repayData = OriginationLibrary.CrossCurrencyRepayData({
            oldLoanId: oldLoanId,
            newLoanTerms: newLoanTerms,
            borrower: borrower_,
            lender: lender,
            rolloverAmounts: _amounts,
            swapParameters: swapParams
        });

        // get funds from new lender, swap them and repay the old loan
        _processRepaymentSwap(oldLoanCurrency, repayAmount, repayData);

        // reset borrower state
        borrower = address(0);
    }

    /**
     * @notice Processes the repayment and currency swap for cross-currency loan repayments.
     *         Any funds that are not covered by closing out the old loan must be covered by
     *         the borrower.
     *
     * @param oldLoanCurrency        The address of the original loan's currency.
     * @param repaymentAmount        Amount needed to repay the old loan (principal + interest).
     * @param repayData              A struct containing all necessary data for
     *                               executing the repayment and swap.
     */
    function _processRepaymentSwap(
        address oldLoanCurrency,
        uint256 repaymentAmount,
        OriginationLibrary.CrossCurrencyRepayData memory repayData
    ) internal {
        // amount = new principal amount - leftover principal
        uint256 amount = repayData.rolloverAmounts.amountFromLender - repayData.rolloverAmounts.leftoverPrincipal;

        // pull funds from the new lender
        IERC20(repayData.newLoanTerms.payableCurrency).safeTransferFrom(
            repayData.lender,
            address(this),
            repayData.newLoanTerms.principal
        );

        // swap the new lender payment from new currency to the original currency
        // the swap will revert if swappedAmount < minAmountOut
        uint256 swappedAmount = _swapExactInputSingle(repayData.newLoanTerms.payableCurrency, oldLoanCurrency, repayData.newLoanTerms.principal, repayData.swapParameters.minAmountOut, repayData.swapParameters.poolFeeTier, address(this));

        if (swappedAmount < amount) {
           uint256 needFromBorrower = amount - swappedAmount;

           // borrower owes
            IERC20(oldLoanCurrency).safeTransferFrom(borrower, address(this), needFromBorrower);
        }

        _repayLoan(borrower, IERC20(oldLoanCurrency), repayData.oldLoanId, repaymentAmount);

        if (swappedAmount > amount) {
            uint256 remainingFunds = swappedAmount - amount;

            // if funds remain, send the difference to the borrower
            IERC20(oldLoanCurrency).safeTransfer(borrower, remainingFunds);
        }
    }

    /**
     * @notice Helper function to repay the original loan.
     *
     * @param _borrower                    The address of the borrower.
     * @param payableCurrency              Payable currency for the loan terms.
     * @param borrowerNoteId               ID of the borrowerNote for the loan to be repaid.
     * @param repayAmount                  The amount to be repaid to the old loan.
     */
    function _repayLoan(
        address _borrower,
        IERC20 payableCurrency,
        uint256 borrowerNoteId,
        uint256 repayAmount
    ) internal {
        // pull BorrowerNote from the caller so that this contract receives collateral upon original loan repayment
        // borrower must approve this withdrawal
        IPromissoryNote(borrowerNote).transferFrom(_borrower, address(this), borrowerNoteId);

        // approve LoanCore to take the total settled amount
        ILoanCore loanCoreInterface = ILoanCore(loanCore);
        payableCurrency.safeApprove(address(loanCoreInterface), repayAmount);

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
     * @notice This function ensures that at the start of every rollover sequence, the borrower
     *         state is reset to address(0).
     */
    modifier whenBorrowerReset() {
        if (borrower != address(0)) revert CCR_BorrowerNotReset(borrower);

        _;
    }

    /**
     * @notice This modifier ensures the rollover functionality is not paused.
     */
    modifier whenNotPaused() {
        if (paused) revert CCR_Paused();

        _;
    }
}