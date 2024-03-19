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
    bytes32 public constant FL_04 = keccak256("LENDER_INTEREST_FEE");
    bytes32 public constant FL_05 = keccak256("LENDER_PRINCIPAL_FEE");
}
