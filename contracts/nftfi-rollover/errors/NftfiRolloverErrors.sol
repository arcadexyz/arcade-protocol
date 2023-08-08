// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title NftfiRolloverErrors
 * @author Non-Fungible Technologies, Inc.
 *
 * This file contains all custom errors for nftfi -> v3 rollover contracts. All errors are
 * prefixed by "NR_" for NftfiRollover. Errors are located in one place to make it possible to
 * holistically look at all nftfi -> V3 rollover failure cases.
 */

// ================================== NFTFI To V3 Rollover ====================================

/**
 * @notice The flash loan callback caller is not recognized. The caller must be the flash
 *         loan provider.
 *
 * @param caller                  The address of the caller.
 * @param lendingPool             Expected address of the flash loan provider.
 */
error NR_UnknownCaller(address caller, address lendingPool);

/**
 * @notice The balance of the borrower is insufficient to repay the difference between
 *         the Nftfi loan and the V3 loan principal minus fees.
 *
 * @param borrower                The address of the borrower.
 * @param amount                  The difference amount.
 * @param balance                 Current balance of the borrower.
 */
error NR_InsufficientFunds(address borrower, uint256 amount, uint256 balance);

/**
 * @notice The allowance of the borrower to the Nftfi -> V3 rollover contract is insufficient
 *          to repay the difference between the Nftfi loan and the V3 loan principal minus fees.
 *
 * @param borrower                The address of the borrower.
 * @param amount                  The difference amount.
 * @param allowance               Current allowance of the borrower.
 */
error NR_InsufficientAllowance(address borrower, uint256 amount, uint256 allowance);

/**
 * @notice An accounting check to verify that either the leftover V3 loan principal is
 *         zero or the amount needed from the borrower to cover any difference is zero.
 *         Either there is leftover principal that needs to be sent to the borrower, or
 *         the borrower needs to send funds to cover the difference between the NFTFI repayment
 *         amount and the new V3 loan principal minus any fees.
 *
 * @param leftoverPrincipal       The leftover principal from the V3 loan.
 * @param needFromBorrower        The amount needed from the borrower to cover the difference.
 */
error NR_FundsConflict(uint256 leftoverPrincipal, uint256 needFromBorrower);

/**
 * @notice After repaying the NFTFI loan, the NFTFI -> V3 rollover contract must be the owner of
 *         the collateral token.
 *
 * @param owner                   The owner of the collateral token.
 */
error NR_NotCollateralOwner(address owner);

/**
 * @notice Only the holder of the obligationReceiptToken can rollover their loan.
 *
 * @param caller                  The address of the caller.
 * @param borrower                Holder of the obligationReceiptToken address
 */
error NR_CallerNotBorrower(address caller, address borrower);

/**
 * @notice The NFTFI and V3 payable currency tokens must be the same so that the flash loan can
 *         be repaid.
 *
 * @param nftfiCurrency           The NFTFI payable currency address.
 * @param v3Currency              The V3 payable currency address.
 */
error NR_CurrencyMismatch(address nftfiCurrency, address v3Currency);

/**
 * @notice The NFTFI and V3 collateral tokens must be the same.
 *
 * @param nftfiCollateral         The NFTFI collateral token address.
 * @param v3Collateral            The V3 collateral token address.
 */
error NR_CollateralMismatch(address nftfiCollateral, address v3Collateral);

/**
 * @notice The NFTFI and V3 collateral token IDs must be the same.
 *
 * @param nftfiCollateralId       The NFTFI collateral token ID.
 * @param v3CollateralId          The V3 collateral token ID.
 */
error NR_CollateralIdMismatch(uint256 nftfiCollateralId, uint256 v3CollateralId);

/**
 * @notice Contract is pause, rollover operations are blocked.
 */
error NR_Paused();
