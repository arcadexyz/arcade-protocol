// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

interface IFeeControllerV2 {
    // ================ Events =================

    event UpdateOriginationFee(uint256 _newFee);
    event UpdateRolloverFee(uint256 _newFee);
    event UpdateCollateralSaleFee(uint256 _newFee);
    event UpdatePayLaterFee(uint256 _newFee);

    // ================ Fee Setters =================

    function setOriginationFee(uint256 _originationFee) external;

    function setRolloverFee(uint256 _rolloverFee) external;

    function setCollateralSaleFee(uint256 _collateralSaleFee) external;

    function setPayLaterFee(uint256 _payLaterFee) external;

    // ================ Fee Getters =================

    function getOriginationFee() external view returns (uint256);

    function getRolloverFee() external view returns (uint256);

    function getCollateralSaleFee() external view returns (uint256);

    function getPayLaterFee() external view returns (uint256);
}