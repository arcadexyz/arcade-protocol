// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

import "./OriginationController.sol";

import "../interfaces/IMigrationBase.sol";
import "../interfaces/ILoanCore.sol";
import "../interfaces/IRepaymentController.sol";
import "../libraries/LoanLibrary.sol";
import "hardhat/console.sol";
contract OriginationControllerCurrencyMigrate is IMigrationBase, OriginationController, ERC721Holder {
    using SafeERC20 for IERC20;

    ISwapRouter public immutable swapRouter;

    constructor(
        address _originationHelpers,
        address _loanCore,
        address _feeController,
        ISwapRouter _swapRouter
    ) OriginationController(_originationHelpers, _loanCore, _feeController) {
        swapRouter = _swapRouter;
    }

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
    ) external override whenNotPaused whenBorrowerReset {}

    /**
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
    ) external returns (uint256 amountOut) {
        require(address(swapRouter) != address(0), "SwapRouter address not set");

        // transfer the specified amount of tokenIn to this contract
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // approve the uniswapv3 router to spend tokenIn
        IERC20(tokenIn).safeApprove(address(swapRouter), amountIn);

        // Setting sqrtPriceLimitX96 to zero makes the parameter inactive.
        // TODO: implement a way to set this parameter.
        // This parameter sets a boundary on the pool's swap price. It defines the
        // worst acceptable price before the transaction reverts.
        // If the price to execute the swap exceeds this limit (due to slippage or
        // market movement), the transaction will fail.
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
        // if (msg.sender != VAULT) revert OCM_UnknownCaller(msg.sender, VAULT);

        // OriginationLibrary.OperationData memory opData = abi.decode(params, (OriginationLibrary.OperationData));

        // // verify this contract started the flash loan
        // if (opData.borrower != borrower) revert OCM_UnknownBorrower(opData.borrower, borrower);
        // // borrower must be set
        // if (borrower == address(0)) revert OCM_BorrowerNotCached();

        // _executeOperation(assets, amounts, feeAmounts, opData);
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
        // if (paused == _pause) revert OCM_StateAlreadySet();

        // paused = _pause;

        // emit PausedStateChanged(_pause);
    }

    /**
     * @notice This function ensures that at the start of every flash loan sequence, the borrower
     *         state is reset to address(0). The migration function that inherits this modifier sets
     *         the borrower state before executing the flash loan and resets it to zero after the
     *         flash loan has been executed.
     */
    modifier whenBorrowerReset() {
        //if (borrower != address(0)) revert OCM_BorrowerNotReset(borrower);

        _;
    }

    /**
     * @notice This modifier ensures the migration functionality is not paused.
     */
    modifier whenNotPaused() {
        // if (paused) revert OCM_Paused();

        _;
    }
}