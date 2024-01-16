// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "./ILoanCore.sol";
import "./IFeeController.sol";

import "../v3/interfaces/IOriginationControllerV3.sol";

import "../external/interfaces/IFlashLoanRecipient.sol";

import "../v2-migration/v2-contracts/v2-interfaces/ILoanCoreV2.sol";
import "../v2-migration/v2-contracts/v2-interfaces/IRepaymentControllerV2.sol";

interface IMigrationBase is IFlashLoanRecipient {
    event PausedStateChanged(bool isPaused);

    function flushToken(IERC20 token, address to) external;

    function pause(bool _pause) external;
}
