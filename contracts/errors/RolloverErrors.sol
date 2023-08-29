// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title RolloverErrors
 * @author Non-Fungible Technologies, Inc.
 *
 * This file contains all custom errors for V2 -> V3 rollover contracts. All errors are
 * prefixed by "R_" for Rollover. Errors are located in one place to make it possible to
 * holistically look at all V2 -> V3 rollover failure cases.
 */

// ================================== V2 To V3 Rollover ====================================

/**
 * @notice The flash loan callback caller is not recognized. The caller must be the flash
 *         loan provider.
 *
 * @param caller                  The address of the caller.
 * @param lendingPool             Expected address of the flash loan provider.
 */
error R_UnknownCaller(address caller, address lendingPool);

/**
 * @notice The balance of the borrower is insufficient to repay the difference between
 *         the V2 loan and the V3 loan principal minus fees.
 *
 * @param borrower                The address of the borrower.
 * @param amount                  The difference amount.
 * @param balance                 Current balance of the borrower.
 */
error R_InsufficientFunds(address borrower, uint256 amount, uint256 balance);

/**
 * @notice The allowance of the borrower to the V2 -> V3 rollover contract is insufficient
 *          to repay the difference between the V2 loan and the V3 loan principal minus fees.
 *
 * @param borrower                The address of the borrower.
 * @param amount                  The difference amount.
 * @param allowance               Current allowance of the borrower.
 */
error R_InsufficientAllowance(address borrower, uint256 amount, uint256 allowance);

/**
 * @notice An accounting check to verify that either the leftover V3 loan principal is
 *         zero or the amount needed from the borrower to cover any difference is zero.
 *         Either there is leftover principal that needs to be sent to the borrower, or
 *         the borrower needs to send funds to cover the difference between the V2 repayment
 *         amount and the new V3 loan principal minus any fees.
 *
 * @param leftoverPrincipal       The leftover principal from the V3 loan.
 * @param needFromBorrower        The amount needed from the borrower to cover the difference.
 */
error R_FundsConflict(uint256 leftoverPrincipal, uint256 needFromBorrower);

/**
 * @notice After repaying the V2 loan, the V2 -> V3 rollover contract must be the owner of
 *         the collateral token.
 *
 * @param owner                   The owner of the collateral token.
 */
error R_NotCollateralOwner(address owner);

/**
 * @notice Only the holder of the borrowerNote can rollover their loan.
 *
 * @param caller                  The address of the caller.
 * @param borrower                Holder of the borrower notes address
 */
error R_CallerNotBorrower(address caller, address borrower);

/**
 * @notice The V2 and V3 payable currency tokens must be the same so that the flash loan can
 *         be repaid.
 *
 * @param v2Currency              The V2 payable currency address.
 * @param v3Currency              The V3 payable currency address.
 */
error R_CurrencyMismatch(address v2Currency, address v3Currency);

/**
 * @notice The V2 and V3 collateral tokens must be the same.
 *
 * @param v2Collateral            The V2 collateral token address.
 * @param v3Collateral            The V3 collateral token address.
 */
error R_CollateralMismatch(address v2Collateral, address v3Collateral);

/**
 * @notice The V2 and V3 collateral token IDs must be the same.
 *
 * @param v2CollateralId          The V2 collateral token ID.
 * @param v3CollateralId          The V3 collateral token ID.
 */
error R_CollateralIdMismatch(uint256 v2CollateralId, uint256 v3CollateralId);

/**
 * @notice The rollover contract does not hold a balance for the token specified to flush.
 */
error R_NoTokenBalance();

/**
 * @notice Contract is paused, rollover operations are blocked.
 */
error R_Paused();

/**
 * @notice The rollover contract is already in the specified pause state.
 */
error R_StateAlreadySet();

/**
 * @notice Cannot pass the zero address as an argument.
 *
 * @param name                    The name of the contract.
 */
error R_ZeroAddress(string name);

/**
 * @notice The borrower address saved in the rollover contract is not the same as the
 *         borrower address provided in the flash loan operation data. The initiator of
 *         the flash loan must be the rollover contract.
 *
 * @param providedBorrower        Borrower address passed in the flash loan operation data.
 * @param cachedBorrower          Borrower address saved in the rollover contract.
 */
error R_UnknownBorrower(address providedBorrower, address cachedBorrower);

/**
 * @notice The borrower state must be address(0) to initiate a rollover sequence.
 *
 * @param borrower                The borrower address.
 */
error R_BorrowerNotReset(address borrower);
