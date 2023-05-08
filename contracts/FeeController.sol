// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IFeeController.sol";
import "./FeeLookups.sol";

import { FC_FeeTooLarge } from "./errors/Lending.sol";

/**
 * @title FeeController
 * @author Non-Fungible Technologies, Inc.
 *
 * The Fee Controller is used by other lending protocol contracts to query for fees
 * for different protocol operations (originations, rollovers, etc). All fees should
 * have setters and getters. In the future, this contract could be extended to
 * support more complex logic (introducing a mapping of users who get a discount, e.g.).
 * Since LoanCore can change the fee controller reference, any changes to this contract
 * can be newly deployed on-chain and adopted.
 */
contract FeeController is IFeeController, FeeLookups, Ownable {
    // ============================================ STATE ==============================================

    /// @dev Fee mapping
    /// @dev Important: these fees may be expressed either in gross amounts or basis
    ///                 points. It's required that the consumer of this controller handle
    ///                 accounting properly based on their own knowledge of the fee type.
    mapping(bytes32 => uint256) public fees;

    /// @dev Max fees
    /// @dev Functionally immutable, can only be set on deployment. Can specify a maximum fee
    ///      for any selector.
    mapping(bytes32 => uint256) public maxFees;

    // ========================================= CONSTRUCTOR ===========================================

    /**
     * @notice Deploy the contract, and set the required max fees to support the lending protocol.
     */
    constructor() {
        /// @dev Vault mint fee - gross
        maxFees[FL_01] = 1 ether;

        /// @dev Origination fees - bps
        maxFees[FL_02] = 10_00;
        maxFees[FL_03] = 10_00;

        /// @dev Rollover fees - bps
        maxFees[FL_04] = 20_00;
        maxFees[FL_05] = 20_00;

        /// @dev Loan closure fees - bps
        maxFees[FL_06] = 10_00;
        maxFees[FL_07] = 50_00;
        maxFees[FL_08] = 10_00;

        /// @dev Lending plus fees - bps
        maxFees[FL_09] = 10_00;
        maxFees[FL_10] = 10_00;
    }

    // ======================================== GETTER/SETTER ==========================================

    /**
     * @notice Set the origination fee to the given value. The caller
     *         must be the owner of the contract.
     *
     * @param selector                      The bytes32 selector for the fee.
     * @param fee                           The fee to set.
     */
    function set(bytes32 selector, uint256 fee) public onlyOwner {
        if (maxFees[selector] != 0 && fee > maxFees[selector]) {
            revert FC_FeeTooLarge(selector, fee, maxFees[selector]);
        }

        fees[selector] = fee;

        emit SetFee(selector, fee);
    }

    /**
     * @notice Get the fee for the given selector.
     *
     * @param selector                      The bytes32 selector for the fee.
     *
     * @return fee                          The fee for the given selector.
     */
    function get(bytes32 selector) external view returns (uint256) {
        return fees[selector];
    }

    /**
     * @notice Get the max for the given selector. Unset max fees return 0.
     *
     * @param selector                      The bytes32 selector for the fee.
     *
     * @return fee                          The maximum fee for the given selector.
     */
    function getMaxFee(bytes32 selector) external view returns (uint256) {
        return maxFees[selector];
    }
}
