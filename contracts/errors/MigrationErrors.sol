// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title MigrationErrors
 * @author Non-Fungible Technologies, Inc.
 *
 * This file contains all custom errors for V3 -> V4 migration operations. All errors are
 * prefixed by "M_" for Rollover. Errors are located in one place to make it possible to
 * holistically look at all V3 -> V4 migration failure cases.
 */

// ================================== V3 To V4 Migration ====================================

/**
 * @notice The flash loan callback caller is not recognized. The caller must be the flash
 *         loan provider.
 *
 * @param caller                  The address of the caller.
 * @param lendingPool             Expected address of the flash loan provider.
 */
error M_UnknownCaller(address caller, address lendingPool);

/**
 * @notice Only the holder of the borrowerNote can rollover their loan.
 */
error M_CallerNotBorrower();

/**
 * @notice Contract is paused, rollover operations are blocked.
 */
error M_Paused();

/**
 * @notice The rollover contract is already in the specified pause state.
 */
error M_StateAlreadySet();

/**
 * @notice Borrower address is not cached of the flash loan callback.
 */
error M_BorrowerNotCached();

/**
 * @notice The borrower address saved in the rollover contract is not the same as the
 *         borrower address provided in the flash loan operation data. The initiator of
 *         the flash loan must be the rollover contract.
 *
 * @param providedBorrower        Borrower address passed in the flash loan operation data.
 * @param cachedBorrower          Borrower address saved in the rollover contract.
 */
error M_UnknownBorrower(address providedBorrower, address cachedBorrower);

/**
 * @notice The borrower state must be address(0) to initiate a rollover sequence.
 *
 * @param borrower                The borrower address.
 */
error M_BorrowerNotReset(address borrower);
