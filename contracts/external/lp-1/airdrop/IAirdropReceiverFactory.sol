// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title IAirdropReceiver
 * @author NFTfi
 * @dev
 */
interface IAirdropReceiverFactory {
    function createAirdropReceiver(address _to) external returns (address, uint256);
}
