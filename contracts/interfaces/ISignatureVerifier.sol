// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "../libraries/LoanLibrary.sol";

interface ISignatureVerifier {
    // ============== Collateral Verification ==============

    function verifyPredicates(
        address collateralAddress,
        uint256 collateralId,
        bytes calldata data
    ) external view returns (bool);
}
