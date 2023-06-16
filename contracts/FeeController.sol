// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IFeeController.sol";
import "./libraries/FeeLookups.sol";

import { FC_FeeOverMax, FC_VaultMintFeeOverMax } from "./errors/Lending.sol";

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

        /// @dev Origination fees - bps
        maxLoanFees[FL_01] = 10_00;
        maxLoanFees[FL_02] = 10_00;

        /// @dev Rollover fees - bps
        maxLoanFees[FL_03] = 20_00;
        maxLoanFees[FL_04] = 20_00;

        /// @dev Loan closure fees - bps
        maxLoanFees[FL_05] = 10_00;
        maxLoanFees[FL_06] = 50_00;
        maxLoanFees[FL_07] = 10_00;
        maxLoanFees[FL_08] = 10_00;
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
            revert FC_FeeOverMax(id, fee, maxLoanFees[id]);
        }

        loanFees[id] = fee;

        emit SetFee(id, fee);
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
     * @return fee                    The fee for the given id.
     */
    function getVaultMintFee() external view override returns (uint64) {
        return vaultMintFee;
    }

    /**
     * @notice Get the fees for loan origination.
     *
     * @return FeesOrigination              Applicable fees for loan origination.
     */
    function getFeesOrigination() external view override returns (FeesOrigination memory) {
        return (
            FeesOrigination (
                loanFees[FL_01],
                loanFees[FL_02],
                loanFees[FL_05],
                loanFees[FL_06],
                loanFees[FL_07]
            )
        );
    }

    /**
     * @notice Get the fees for loan rollover.
     *
     * @return FeesRollover              Applicable fees for a loan rollover.
     */
    function getFeesRollover() external view override returns (FeesRollover memory) {
        return (
            FeesRollover (
                loanFees[FL_03],
                loanFees[FL_04]
            )
        );
    }

    /**
     * @notice Get the max lending fee for the given id. Unset max fees return 0.
     *
     * @param id                      The bytes32 id for the fee.
     *
     * @return fee                    The maximum fee for the given id.
     */
    function getMaxLendingFee(bytes32 id) external view override returns (uint16) {
        return maxLoanFees[id];
    }

    /**
     * @notice Get the max vault mint fee.
     *
     * @return fee                The maximum fee for the given id.
     */
    function getMaxVaultMintFee() external view override returns (uint64) {
        return maxVaultMintFee;
    }
}
