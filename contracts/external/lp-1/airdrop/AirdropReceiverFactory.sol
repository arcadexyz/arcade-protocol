// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/proxy/Clones.sol";

import "../interfaces/INftfiHub.sol";
import "../utils/ContractKeys.sol";

import "./AirdropReceiver.sol";
import "./IAirdropReceiverFactory.sol";

/**
 * @title AirdropReceiver
 * @author NFTfi
 * @dev
 */
contract AirdropReceiverFactory is IAirdropReceiverFactory {
    INftfiHub public immutable hub;

    event AirdropReceiverCreated(
        address indexed instance,
        uint256 indexed receiverId,
        address indexed owner,
        address creator
    );

    constructor(address _admin, address _nftfiHub) {
        hub = INftfiHub(_nftfiHub);
    }

    function createAirdropReceiver(address _to) external override returns (address, uint256) {
        address receiverImpl = hub.getContract(ContractKeys.AIRDROP_RECEIVER);

        address instance = Clones.clone(receiverImpl);

        uint256 wrapperId = AirdropReceiver(instance).initialize(_to);

        IPermittedNFTs(hub.getContract(ContractKeys.PERMITTED_NFTS)).setNFTPermit(
            instance,
            ContractKeys.AIRDROP_WRAPPER_STRING
        );

        emit AirdropReceiverCreated(instance, wrapperId, _to, msg.sender);

        return (instance, wrapperId);
    }
}
