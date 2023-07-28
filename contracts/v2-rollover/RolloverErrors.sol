// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title RolloverErrors
 * @author Non-Fungible Technologies, Inc.
 *
 * This file contains all custom errors for v2 -> v3 rollover contracts. All errors are
 * prefixed by "_R" for Rollover. Errors are located in one place to make it possible to
 * holistically look at all v2 -> V3 rollover failure cases.
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
 * @notice The flash loan callback initiator is not recognized. The initiator must be the
 *         rollover contract.
 *
 * @dev AAVE flash loans return the initiator of the flash loan, in the callback interface.
 *      This is not provided in the Balancer callback interface. The initiator is the
 *      rollover contract, calling for the flash loan to repay V2 loan.
 *
 * @param initiator               The address of the initiator.
 * @param rolloverContract        Address of the v2 -> v3 rollover contract.
 */
error R_UnknownInitiator(address initiator, address rolloverContract);

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
 * @notice The rollover contract does not hold a balance for the token specified to flush.
 */
error R_NoTokenBalance();
