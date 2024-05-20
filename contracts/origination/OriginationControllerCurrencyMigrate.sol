// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

import "./OriginationController.sol";

import "../interfaces/ICurrencyMigrationBase.sol";
import "../interfaces/ILoanCore.sol";
import "../interfaces/IRepaymentController.sol";
import "../libraries/LoanLibrary.sol";
import "../libraries/InterestCalculator.sol";

import "../external/uniswapV3/interfaces/IUniswapV3Pool.sol";
import "../external/uniswapV3/libraries/PoolAddress.sol";

import {
    OCCM_UnknownBorrower,
    OCCM_UnknownCaller,
    OCCM_BorrowerNotCached,
    OCCM_BorrowerNotReset,
    OCCM_StateAlreadySet,
    OCCM_Paused,
    OCCM_InvalidState,
    OCCM_SideMismatch,
    OCCM_CurrencyMatch,
    OCCM_CollateralMismatch,
    OCCM_LenderIsBorrower,
    OCCM_CallerNotBorrower
} from "../errors/Lending.sol";

import "hardhat/console.sol";
contract OriginationControllerCurrencyMigrate is ICurrencyMigrationBase, OriginationController, ERC721Holder {
    using SafeERC20 for IERC20;

    /// @notice Balancer vault
    address private constant VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    /// @notice UniswapV3Factory
    address private constant POOL_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;

    /// @notice lending protocol
    address private immutable borrowerNote;
    address private immutable repaymentController;

    /// @notice State variable used for checking the inheriting contract initiated the flash
    ///         loan. When the migration function is called the borrowers address is cached here
    ///         and checked against the opData in the flash loan callback.
    address private borrower;

    /// @notice state variable for pausing the contract
    bool public paused;

    ISwapRouter public immutable swapRouter;

    constructor(
        address _originationHelpers,
        address _loanCore,
        address _borrowerNote,
        address _repaymentController,
        address _feeController,
        ISwapRouter _swapRouter
    ) OriginationController(_originationHelpers, _loanCore, _feeController) {
        borrowerNote = _borrowerNote;
        repaymentController = _repaymentController;
        swapRouter = _swapRouter;
    }

    // ======================================= Currency MIGRATION =============================================

    /**
     * @notice Migrate an active loan on from one currency to another. This function validates new loan
     *         terms against the old terms. It calculates the amounts needed to settle the old loan, and
     *         then executes the migration.
     *
     * @dev This function is only callable by the borrower of the loan.
     * @dev This function is only callable when the migration flow is not paused.
     * @dev For migrations where the lender is the same, a flash loan is initiated to repay the old loan.
     *      In order for the flash loan to be repaid, the lender must have approved this contract to
     *      pull the total amount needed to repay the loan.
     *
     * @param oldLoanId                 The ID of the original loan to be migrated.
     * @param newTerms                  The terms of the new loan.
     * @param lender                    The address of the new lender.
     * @param sig                       The signature of the loan terms.
     * @param sigProperties             The properties of the signature.
     * @param itemPredicates            The predicates for the loan.
     */
    function migrateCurrencyLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata newTerms,
        address lender,
        address newCurrency, // TODO: add to Natpsec
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external override whenNotPaused whenBorrowerReset {
        LoanLibrary.LoanData memory oldLoanData = ILoanCore(loanCore).getLoan(oldLoanId);

        // ------------ Migration Validation ------------
        if (oldLoanData.state != LoanLibrary.LoanState.Active) revert OCCM_InvalidState(uint8(oldLoanData.state));

        _validateCurrencyMigration(oldLoanData.terms, newTerms, oldLoanId, newCurrency);

        {
            (bytes32 sighash, address externalSigner) = _recoverSignature(newTerms, sig, sigProperties, Side.LEND, lender, itemPredicates, "");

            // counterparty validation
            if (!isSelfOrApproved(lender, externalSigner) && !OriginationLibrary.isApprovedForContract(lender, sig, sighash)) {
                revert OCCM_SideMismatch(externalSigner);
            }

            // new lender cannot be the same as the borrower
            if (msg.sender == lender) revert OCCM_LenderIsBorrower();

            // consume new loan nonce
            loanCore.consumeNonce(externalSigner, sigProperties.nonce, sigProperties.maxUses);
        }

        // ------------ Migration Execution ------------
        // collect and distribute settled amounts
        (
            OriginationLibrary.RolloverAmounts memory amounts,
            LoanLibrary.FeeSnapshot memory feeSnapshot,
            uint256 repayAmount,
            bool flashLoanTrigger
        ) = _migrate(oldLoanId, oldLoanData, newTerms.principal, newTerms.payableCurrency, msg.sender, lender);

        // repay original loan via flash loan
        _initiateFlashLoan(oldLoanId, newTerms, msg.sender, lender, amounts, repayAmount, oldLoanData.terms.payableCurrency);

        // initialize new loan
        _initializeMigrationLoan(newTerms, msg.sender, lender, feeSnapshot);

        // Run predicates check at the end of the function, after vault is in escrow. This makes sure
        // that re-entrancy was not employed to withdraw collateral after the predicates check occurs.
        if (itemPredicates.length > 0) originationHelpers.runPredicatesCheck(msg.sender, lender, newTerms, itemPredicates);
    }

    /** TODO: make this function internal
     * @notice swapExactInputSingle swaps a fixed amount of tokenIn for a maximum possible amount of
     *         tokenOut by calling `exactInputSingle` in the swap router.
     *
     * @dev The calling address must approve this contract to spend at least amountIn worth of tokenIn.
     *
     * @param tokenIn                   Address of the token being swapped.
     * @param tokenOut                  Address of the token to be received.
     * @param amountIn                  The exact amount of tokenIn that will be swapped for tokenOut.
     * @param amountOutMinimum          Minimum amount of tokenOut expected. Helps protect against
     *                                  getting an unusually bad price for a trade due to a front
     *                                  running, sandwich or another type of price manipulation.
     * @param fee                       The fee tier of the pool. Determines the pool contract in
     *                                  which to execute the swap.
     * @param recipient                 Address receiving the output token
     *
     * @return amountOut                The amount of tokenOut received.
     */
    function swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint24 fee,
        address recipient
    ) internal returns (uint256 amountOut) {
        require(address(swapRouter) != address(0), "SwapRouter address not set"); // TODO: add to custom errors

        // approve the uniswapv3 router to spend tokenIn
        IERC20(tokenIn).safeApprove(address(swapRouter), amountIn);

        // Setting sqrtPriceLimitX96 to zero makes the parameter inactive.
        // This parameter sets a boundary on the pool's swap price. It defines the
        // worst acceptable price before the transaction reverts. Allows for partial
        // swaps. hence the here is zero value.
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

    // =================================== MIGRATION VALIDATION =========================================

    /**
     * @notice Validates that the migration is valid. If any of these conditionals are not met
     *         the transaction will revert.
     *
     * @dev All whitelisted payable currencies and collateral must be whitelisted.
     *
     * @param sourceLoanTerms           The terms of the original loan.
     * @param newLoanTerms              The terms of the new loan.
     * @param borrowerNoteId            The ID of the borrowerNote for the old loan.
     */
    function _validateCurrencyMigration(
        LoanLibrary.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms memory newLoanTerms,
        uint256 borrowerNoteId,
        address newCurrency // TODO: add to Natpsec
    ) internal view {
        // ------------- Caller Validation -------------
        address _borrower = IPromissoryNote(borrowerNote).ownerOf(borrowerNoteId);

        if (_borrower != msg.sender) revert OCCM_CallerNotBorrower();

        // ------------- Migration Terms Validation -------------
        // currency must not be the same
        if (sourceLoanTerms.payableCurrency == newLoanTerms.payableCurrency) {
            revert OCCM_CurrencyMatch(sourceLoanTerms.payableCurrency, newLoanTerms.payableCurrency);
        }

        // collateral address and id must be the same
        if (sourceLoanTerms.collateralAddress != newLoanTerms.collateralAddress || sourceLoanTerms.collateralId != newLoanTerms.collateralId) {
            revert OCCM_CollateralMismatch(
                sourceLoanTerms.collateralAddress,
                sourceLoanTerms.collateralId,
                newLoanTerms.collateralAddress,
                newLoanTerms.collateralId
            );
        }

        newLoanTerms.payableCurrency = newCurrency;

        // ------------- New LoanTerms Validation -------------
        originationHelpers.validateLoanTerms(newLoanTerms);
    }

    // ========================================= HELPERS ================================================

    /**
     * @notice Helper function to distribute funds based on the migration amounts. A flash loan must be
     *         initiated to repay the old loan.
     *
     * @param oldLoanId                 The ID of the original loan to be migrated.
     * @param oldLoanData               The loan data of the original loan.
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
        LoanLibrary.LoanData memory oldLoanData,
        uint256 newPrincipalAmount,
        address newCurrency,
        address borrower_,
        address lender
    ) internal nonReentrant returns (
        OriginationLibrary.RolloverAmounts memory amounts,
        LoanLibrary.FeeSnapshot memory feeSnapshot,
        uint256 repayAmount,
        bool flashLoanTrigger
    ) {
        address oldLender = ILoanCore(loanCore).lenderNote().ownerOf(oldLoanId);
        IERC20 payableCurrency = IERC20(oldLoanData.terms.payableCurrency);

        // get fee snapshot from fee controller
        (feeSnapshot) = feeController.getFeeSnapshot();

        // Calculate settle amounts
        (amounts, repayAmount) = _calculateCurrencyMigrationAmounts(
            oldLoanData,
            newPrincipalAmount,
            newCurrency,
            lender,
            oldLender
        );

        // initiate flash loan for the funds needed to repay the original loan in old curency
        flashLoanTrigger = true;

        // TODO: All mount coming from the new lender. Resolve this
        // if (amounts.needFromBorrower > 0) {
        //     // Borrower owes from old loan
        //     payableCurrency.safeTransferFrom(borrower_, address(this), amounts.needFromBorrower);
        // }
    }

    /**
     * @notice Helper function to calculate the amounts needed to settle the old loan.
     *
     * @param oldLoanData               The terms of the original loan.
     * @param newPrincipalAmount        The principal amount of the new loan.
     * @param lender                    The address of the new lender.
     * @param oldLender                 The address of the old lender.
     *
     * @return amounts                  The migration amounts.
     * @return repayAmount              The amount needed to repay the original loan.
     */
    function _calculateCurrencyMigrationAmounts(
        LoanLibrary.LoanData memory oldLoanData,
        uint256 newPrincipalAmount,
        address newCurrency,
        address lender,
        address oldLender
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

        amounts = rolloverAmounts(
            oldLoanData.terms.principal,
            interestAmount,
            newPrincipalAmount,
            lender,
            oldLender,
            0,
            0
        );
    }

    // TODO: Add Natspec
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

        emit CurrencyRollover(lender, borrower_, newTerms.collateralId, newLoanId);
    }

    // TODO: confirm this is needed then add Natspec if keeping
    function _getLoanCore() public view returns (ILoanCore) {
        return ILoanCore(loanCore);
    }

    // TODO: this is not fetching the correct price. FIX
    // TODO: add Natspec
    // TODO: WHAT IF NOT BOTH TOKENS ARE 18 DECIMAL? NEED TO ADJUST
    // fetch current price from a Uniswap V3 Pool
    // returned price should reflect the price of tokenOut in terms of tokenIn
    // If tokenIn is DAI and tokenOut is WETH, the price will indicate how much DAI
    // is worth in WETH.
    function _fetchCurrentPrice(address tokenIn, address tokenOut, uint24 poolFee) public view returns (uint256 price) {
        poolFee = 3000; // 0.3% fee TODO: REMOVE HARDCODED VALUE
        PoolAddress.PoolKey memory poolKey = PoolAddress.getPoolKey(tokenIn, tokenOut, poolFee);
        address pool = PoolAddress.computeAddress(POOL_FACTORY, poolKey);
        IUniswapV3Pool uniswapPool = IUniswapV3Pool(pool);

        (uint160 sqrtPriceX96,,,,,,) = uniswapPool.slot0();

        uint256 sqrtPrice = uint256(sqrtPriceX96);

        // square to get the price
        uint256 priceX192 = sqrtPrice * sqrtPrice;

        // scale down by dividing by 2^192, which is equivalent to dividing by 1e18 twice
        uint256 scalingFactor = 1e18;
        price = (priceX192 / scalingFactor) / scalingFactor;


        // in Uniswap, the token with the smaller address should be tokenIn and the
        // token with the larger address should be tokenOut
        // if tokenIn is greater than tokenOut, invert the price
        if (tokenIn > tokenOut) {
            price = type(uint256).max / price;
        }

        return price;
    }

    // ======================================= FLASH LOAN OPS ===========================================

    /**
     * @notice Helper function to initiate a flash loan. The flash loan amount is the total amount
     *         needed to repay the old loan.
     *
     * @param oldLoanId                 The ID of the original loan to be migrated.
     * @param newLoanTerms              The terms of the new currency loan.
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
        uint256 repayAmount,
        address oldLoanCurrency // TODO: add to Natpsec
    ) internal {
        // cache borrower address for flash loan callback
        borrower = borrower_;

        IERC20[] memory assets = new IERC20[](1);
        assets[0] = IERC20(oldLoanCurrency);

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
        if (msg.sender != VAULT) revert OCCM_UnknownCaller(msg.sender, VAULT);

        OriginationLibrary.OperationData memory opData = abi.decode(params, (OriginationLibrary.OperationData));

        // verify this contract started the flash loan
        if (opData.borrower != borrower) revert OCCM_UnknownBorrower(opData.borrower, borrower);
        // borrower must be set
        if (borrower == address(0)) revert OCCM_BorrowerNotCached();

        _executeOperation(assets, amounts, feeAmounts, opData);
    }

    /**
     * @notice Executes repayment of original loan and initialization of new currency loan. Any funds
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
        IERC20 asset = assets[0]; // old loan currency

        _repayLoan(borrower, asset, opData.oldLoanId, amounts[0]); // flashloan used to repay old loan

        // amount = original loan repayment amount - leftover principal + flash loan fee
        uint256 amount = opData.migrationAmounts.amountFromLender - opData.migrationAmounts.leftoverPrincipal + premiums[0]; // TODO: what is the purpose of this?

        uint256 scaledAmount = amounts[0] * 1e18;

        uint24 fee = 3000; // 0.3% fee // TODO: REMOVE HARDCODED VALUE
        uint256 price = _fetchCurrentPrice(address(asset), opData.newLoanTerms.payableCurrency, 3000);

        uint256 amountInNewCurrency = scaledAmount / price;


        // pull funds from the lender to repay the flash loan
        IERC20(opData.newLoanTerms.payableCurrency).safeTransferFrom(
            opData.lender,
            address(this),
            amountInNewCurrency
        );

        // swap the lender paid funds into the original payable currency
        uint256 swappedAmount = swapExactInputSingle(opData.newLoanTerms.payableCurrency, address(asset), amountInNewCurrency, 0, fee, address(this));

        // check if the swapped amount is sufficient
        require(swappedAmount >= amounts[0] + premiums[0], "Swap output insufficient to repay the flash loan."); // TODO: add to custom errors

        if (opData.migrationAmounts.amountToBorrower > 0) {
            // If new amount is greater than old loan repayment amount, send the difference to the borrower
            asset.safeTransfer(borrower, opData.migrationAmounts.amountToBorrower);
        }

        // Make flash loan repayment
        // Balancer requires a transfer back the vault
        asset.safeTransfer(VAULT, amounts[0] + premiums[0]);
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
        ILoanCore loanCoreInterface = _getLoanCore();
        payableCurrency.safeApprove(address(loanCoreInterface), repayAmount);

        // repay original currency loan, this contract receives the collateral
        IRepaymentController(repaymentController).repayFull(borrowerNoteId);
    }

    // ========================================== ADMIN =================================================

    /**
     * @notice Function to be used by the contract owner to pause the contract.
     *
     * @dev This function is only to be used if a vulnerability is found in the
     *      currency migration flow.
     *
     * @param _pause              The state to set the contract to.
     */
    function pause(bool _pause) external override onlyRole(MIGRATION_MANAGER_ROLE) {
        if (paused == _pause) revert OCCM_StateAlreadySet();

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
        if (borrower != address(0)) revert OCCM_BorrowerNotReset(borrower);

        _;
    }

    /**
     * @notice This modifier ensures the migration functionality is not paused.
     */
    modifier whenNotPaused() {
        if (paused) revert OCCM_Paused();

        _;
    }
}