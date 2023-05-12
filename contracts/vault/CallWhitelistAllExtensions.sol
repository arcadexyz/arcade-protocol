// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../interfaces/IERC721Permit.sol";
import "../external/interfaces/IDelegationRegistry.sol";

import "./CallWhitelist.sol";
import "./CallWhitelistDelegation.sol";
import "./CallWhitelistApprovals.sol";

/**
 * @title CallWhitelistAllExtensions
 * @author Non-Fungible Technologies, Inc.
 *
 * CallWhitelist with both the approvals and delegation extension.
 * See CallWhitelist, CallWhitelistApprovals, and CallWhitelistDelegation
 * contract descriptions for more information.
 */
contract CallWhitelistAllExtensions is CallWhitelist, CallWhitelistApprovals, CallWhitelistDelegation {
    constructor(address _registry) CallWhitelistDelegation(_registry) {}
}
