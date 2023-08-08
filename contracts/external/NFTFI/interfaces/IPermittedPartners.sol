// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

interface IPermittedPartners {
    function getPartnerPermit(address _partner) external view returns (uint16);
}
