// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "./IOriginationControllerBase.sol";

import "../libraries/LoanLibrary.sol";

interface IOriginationControllerInterestRateSwap is IOriginationControllerBase {

    // ============= Data Types =============

    struct SwapData {
        address vaultedCurrency;
        uint256 payableToVaultedCurrencyRatio;
    }

    // ============= Loan Origination =============

    function initializeSwap(
        LoanLibrary.LoanTerms calldata loanTerms,
        SwapData calldata swapData,
        address borrower,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties
    ) external returns (uint256 loanId, uint256 bundleId);
}
