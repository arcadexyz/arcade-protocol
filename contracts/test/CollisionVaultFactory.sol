// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.18;

import "../vault/VaultFactory.sol";

contract CollisionVaultFactory is VaultFactory {
  // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Deploys a new VaultFactory, with a given template and whitelist.
     *
     * @param _template          The address of the template contract for vaults.
     * @param _whitelist         The address of the CallWhitelist contract.
     * @param _feeController     The contract reporting fees for vault minting.
     * @param _descriptor        The resource descriptor contract.
     */
    constructor(
        address _template,
        address _whitelist,
        address _feeController,
        address _descriptor
    ) VaultFactory(_template, _whitelist, _feeController, _descriptor) {}


    function initializeCollision(address target, address to) external payable returns (uint256) {
        uint256 mintFee = feeController.getVaultMintFee();

        if (msg.value < mintFee) revert VF_InsufficientMintFee(msg.value, mintFee);

        uint256 targetId = uint256(uint160(target));
        uint256 collidingId = 2**160 + targetId;

        // collidingId will resolve to the same address when truncated to 160 bits
        _safeMint(to, collidingId);

        if (msg.value > mintFee) payable(msg.sender).transfer(msg.value - mintFee);

        emit VaultCreated(target, to);
        return collidingId;
    }
}
