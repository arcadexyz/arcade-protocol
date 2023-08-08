// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

interface IPermittedAirdrops {
    function isValidAirdrop(bytes memory _addressSig) external view returns (bool);
}
