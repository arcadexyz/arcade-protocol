// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title Rollover Errors
 * @author Non-Fungible Technologies, Inc.
 *
 * This file contains custom errors for the cross currency rollover contract, with errors
 * prefixed by "CCR_" for CrossCurrencyRollover.
 * Errors located in one place to make it possible to holistically look at all
 * protocol failure cases.
 */

// ================================== CROSS CURRENCY ROLLOVER ====================================
/// @notice All errors prefixed with CCR_, to separate from other contracts in the protocol.

/**
 * @notice Only the holder of the borrowerNote can rollover their loan.
 */
error CCR_CallerNotBorrower();

/**
 * @notice Contract is paused, rollover operations are blocked.
 */
error CCR_Paused();

/**
 * @notice The rollover contract is already in the specified pause state.
 */
error CCR_StateAlreadySet();

/**
 * @notice Ensure valid loan state for loan lifecycle operations.
 *
 * @param state                   Current state of a loan according to LoanState enum.
 */
error CCR_InvalidState(uint8 state);

/**
 * @notice Signer is attempting to take the wrong side of the loan.
 *
 * @param signer                   The address of the external signer.
 */
error CCR_SideMismatch(address signer);

/**
 * @notice New currency should not match original loan currency.
 *
 * @param oldCurrency               The currency of the active loan.
 * @param newCurrency               The currency of the new loan.
 */
error CCR_SameCurrency(address oldCurrency, address newCurrency);

/**
 * @notice New collateral does not match for a loan migration request.
 *
 * @param oldCollateralAddress       The address of the active loan's collateral.
 * @param newCollateralAddress       The token ID of the active loan's collateral.
 * @param oldCollateralId            The address of the new loan's collateral.
 * @param newCollateralId            The token ID of the new loan's collateral.
 */
error CCR_CollateralMismatch(
    address oldCollateralAddress,
    uint256 oldCollateralId,
    address newCollateralAddress,
    uint256 newCollateralId
);

/**
 * @notice The lender specified for a migration cannot be the current borrower.
 */
error CCR_LenderIsBorrower();

/**
 * @notice Zero address passed in where not allowed.
 *
 * @param addressType               The name of the parameter for which a zero address was provided.
 */
error CCR_ZeroAddress(string addressType);
