// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

interface IFeeController {
    // ================ Structs ================

    struct FeesOrigination {
        uint16 borrowerOriginationFee;
        uint16 lenderOriginationFee;
        uint16 lenderDefaultFee;
        uint16 lenderInterestFee;
        uint16 lenderPrincipalFee;
    }

    struct FeesRollover {
        uint16 borrowerRolloverFee;
        uint16 lenderRolloverFee;
    }

    // ================ Events =================

    event SetLendingFee(bytes32 indexed id, uint16 fee);

    event SetVaultMintFee(uint64 fee);

    // ================ Getter/Setter =================

    function setLendingFee(bytes32 id, uint16 fee) external;

    function setVaultMintFee(uint64 fee) external;

    function getLendingFee(bytes32 id) external view returns (uint16);

    function getVaultMintFee() external view returns (uint64);

    function getFeesOrigination() external view returns (FeesOrigination memory);

    function getFeesRollover() external view returns (FeesRollover memory);

    function getMaxLendingFee(bytes32 id) external view returns (uint16);

    function getMaxVaultMintFee() external view returns (uint64);
}