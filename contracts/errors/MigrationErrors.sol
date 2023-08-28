// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title MigrationErrors
 * @author Non-Fungible Technologies, Inc.
 *
 * This file contains all custom errors for v3 migration contracts from competitor lending protocol #1.
 * All errors are prefixed by "MR_" for MigrationRollover. Errors are located in one place to make it
 * possible to holistically look at all migratin over failure cases.
 */

// ================================== LP1 To V3 Migration ====================================

/**
 * @notice The flash loan callback caller is not recognized. The caller must be the flash
 *         loan provider.
 *
 * @param caller                  The address of the caller.
 * @param lendingPool             Expected address of the flash loan provider.
 */
error MR_UnknownCaller(address caller, address lendingPool);

/**
 * @notice The balance of the borrower is insufficient to repay the difference between
 *         the loan and the V3 loan principal minus fees.
 *
 * @param borrower                The address of the borrower.
 * @param amount                  The difference amount.
 * @param balance                 Current balance of the borrower.
 */
error MR_InsufficientFunds(address borrower, uint256 amount, uint256 balance);

/**
 * @notice The allowance of the borrower to the V3 migration contract is insufficient
 *          to repay the difference between the LP1 loan and the V3 loan principal minus fees.
 *
 * @param borrower                The address of the borrower.
 * @param amount                  The difference amount.
 * @param allowance               Current allowance of the borrower.
 */
error MR_InsufficientAllowance(address borrower, uint256 amount, uint256 allowance);

/**
 * @notice An accounting check to verify that either the leftover V3 loan principal is
 *         zero or the amount needed from the borrower to cover any difference is zero.
 *         Either there is leftover principal that needs to be sent to the borrower, or
 *         the borrower needs to send funds to cover the difference between the LP1 repayment
 *         amount and the new V3 loan principal minus any fees.
 *
 * @param leftoverPrincipal       The leftover principal from the V3 loan.
 * @param needFromBorrower        The amount needed from the borrower to cover the difference.
 */
error MR_FundsConflict(uint256 leftoverPrincipal, uint256 needFromBorrower);

/**
 * @notice After repaying the LP1 loan, the LP1 -> V3 migration contract must be the owner of
 *         the collateral token.
 *
 * @param owner                   The owner of the collateral token.
 */
error MR_NotCollateralOwner(address owner);

/**
 * @notice Only the holder of the obligationReceiptToken can migrate their loan.
 *
 * @param caller                  The address of the caller.
 * @param borrower                Holder of the obligationReceiptToken address
 */
error MR_CallerNotBorrower(address caller, address borrower);

/**
 * @notice The LP1 and V3 payable currency tokens must be the same so that the flash loan can
 *         be repaid.
 *
 * @param oldCurrency               The payable currency address for the old loan.
 * @param v3Currency                The V3 payable currency address.
 */
error MR_CurrencyMismatch(address oldCurrency, address v3Currency);

/**
 * @notice The LP1 and V3 collateral tokens must be the same.
 *
 * @param oldCollateral             The collateral token address for the old loan.
 * @param v3Collateral              The V3 collateral token address.
 */
error MR_CollateralMismatch(address oldCollateral, address v3Collateral);

/**
 * @notice The LP1 and V3 collateral token IDs must be the same.
 *
 * @param oldCollateralId           The old collateral token ID for the old loan.
 * @param v3CollateralId            The V3 collateral token ID.
 */
error MR_CollateralIdMismatch(uint256 oldCollateralId, uint256 v3CollateralId);

/**
 * @notice Contract is paused, migration operations are blocked.
 */
error MR_Paused();
