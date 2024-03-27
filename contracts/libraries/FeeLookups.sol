// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title FeeLookups
 * @author Non-Fungible Technologies, Inc.
 *
 * Enumerates unique identifiers for fee identifiers
 * that the lending protocol uses.
 */
abstract contract FeeLookups {
    /// @dev Loan closure fees: amount in bps, payable in loan token
    bytes32 public constant FL_01 = keccak256("LENDER_INTEREST_FEE");
    bytes32 public constant FL_02 = keccak256("LENDER_PRINCIPAL_FEE");
}
