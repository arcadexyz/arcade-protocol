// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IFeeController.sol";

import "./libraries/FeeLookups.sol";
import "./libraries/LoanLibrary.sol";
import "./libraries/Constants.sol";

import { FC_LendingFeeOverMax, FC_VaultMintFeeOverMax } from "./errors/Lending.sol";

/**
 * @title FeeController
 * @author Non-Fungible Technologies, Inc.
 *
 * The Fee Controller is used by other lending protocol contracts to query for fees
 * for different protocol operations (loan origination, rollovers, etc). All fees should
 * have setters and getters. In the future, this contract could be extended to
 * support more complex logic (introducing a mapping of users who get a discount, e.g.).
 * Since LoanCore can change the fee controller reference, any changes to this contract
 * can be newly deployed on-chain and adopted.
 */
contract FeeController is IFeeController, FeeLookups, Ownable {
    // ============================================ STATE ==============================================

    /// @dev Fee for minting a vault.
    uint64 public vaultMintFee;

    /// @dev Max fee for minting a vault.
    uint64 public immutable maxVaultMintFee;

    /// @dev Fee mapping for lending protocol operations.
    /// @dev Important: these fees are expressed in basis points. It's required that
    ///                 the consumer of this controller handle accounting properly based
    ///                 on their own knowledge of the fee type.
    mapping(bytes32 => uint16) public loanFees;

    /// @dev Max fees for lending protocol operations.
    /// @dev Functionally immutable, can only be set on deployment. Can specify a maximum fee
    ///      for any id.
    mapping(bytes32 => uint16) public maxLoanFees;

    // ========================================= CONSTRUCTOR ===========================================

    /**
     * @notice Deploy the contract, and set the required max fees to support the lending protocol.
     */
    constructor() {
        /// @dev Vault mint fee - gross
        maxVaultMintFee = 1 ether;
        /// @dev Lending fees
        maxLoanFees[FL_01] = 50_00;
        maxLoanFees[FL_02] = 10_00;
    }

    // ======================================== GETTER/SETTER ==========================================

    /**
     * @notice Set the protocol fee for a given operation to the given value.
     *         The caller must be the owner of the contract.
     *
     * @param id                            The bytes32 identifier for the fee.
     * @param fee                           The fee to set.
     */
    function setLendingFee(bytes32 id, uint16 fee) public override onlyOwner {
        if (maxLoanFees[id] != 0 && fee > maxLoanFees[id]) {
            revert FC_LendingFeeOverMax(id, fee, maxLoanFees[id]);
        }

        loanFees[id] = fee;

        emit SetLendingFee(id, fee);
    }

    /**
     * @notice Set the vault mint fee. The caller must be the owner of the contract.
     *
     * @param fee                           The fee to set.
     */
    function setVaultMintFee(uint64 fee) public override onlyOwner {
        if (maxVaultMintFee != 0 && fee > maxVaultMintFee) {
            revert FC_VaultMintFeeOverMax(fee, maxVaultMintFee);
        }

        vaultMintFee = fee;

        emit SetVaultMintFee(fee);
    }

    /**
     * @notice Get the fee for the given lending protocol fee id.
     *
     * @param id                      The bytes32 id for the fee.
     *
     * @return fee                    The fee for the given id.
     */
    function getLendingFee(bytes32 id) external view override returns (uint16) {
        return loanFees[id];
    }

    /**
     * @notice Get the vault mint fee.
     *
     * @return vaultMintFee            The fee for minting a vault.
     */
    function getVaultMintFee() external view override returns (uint64) {
        return vaultMintFee;
    }

    /**
     * @notice Get the borrower and lender fees for loan origination. Additionally, return
     *         a fee snapshot for the loan.
     *
     * @return feeSnapshot              A fee snapshot for the loan.
     */
    function getFeeSnapshot() external view override returns (
        LoanLibrary.FeeSnapshot memory feeSnapshot
    ) {
        feeSnapshot = LoanLibrary.FeeSnapshot({
            lenderInterestFee: loanFees[FL_01],
            lenderPrincipalFee: loanFees[FL_02]
        });
    }

    /**
     * @notice Get the max lending fee for the given id. Unset max fees return 0.
     *
     * @param id                      The bytes32 id for the fee.
     *
     * @return maxLoanFee             The maximum fee for the given id.
     */
    function getMaxLendingFee(bytes32 id) external view override returns (uint16) {
        return maxLoanFees[id];
    }

    /**
     * @notice Get the max vault mint fee.
     *
     * @return maxVaultMintFee        The maximum fee for minting a vault.
     */
    function getMaxVaultMintFee() external view override returns (uint64) {
        return maxVaultMintFee;
    }
}
