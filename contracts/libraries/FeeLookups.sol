// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

/**
 * @title FeeLookups
 * @author Non-Fungible Technologies, Inc.
 *
 * Enumerates unique identifiers for any fee that can be looked up.
 */
library FeeLookups {
    /// @dev Vault mint fee: gross amount, payable in ETH
    bytes32 public constant FL_01 = keccak256("VAULT_MINT_FEE");

    /// @dev Origination fees: amount in bps, payable in loan token
    bytes32 public constant FL_02 = keccak256("BORROWER_ORIGINATION_FEE");
    bytes32 public constant FL_03 = keccak256("LENDER_ORIGINATION_FEE");

    /// @dev Rollover fees: amount in bps, payable in loan token
    bytes32 public constant FL_04 = keccak256("BORROWER_ROLLOVER_FEE");
    bytes32 public constant FL_05 = keccak256("LENDER_ROLLOVER_FEE");

    /// @dev Loan closure fees, payable in loan token
    bytes32 public constant FL_06 = keccak256("LENDER_CLAIM_FEE");
    bytes32 public constant FL_07 = keccak256("LENDER_INTEREST_FEE");
    bytes32 public constant FL_08 = keccak256("LENDER_PRINCIPAL_FEE");

    /// @dev Lending plus fees: amount in bps, payable in loan token
    bytes32 public constant FL_09 = keccak256("COLLATERAL_SALE_FEE");
    bytes32 public constant FL_10 = keccak256("BNPL_FEE");
}