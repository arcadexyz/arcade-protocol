// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "./IOriginationControllerBase.sol";

import "../libraries/LoanLibrary.sol";

interface IOriginationControllerInterestRateSwap is IOriginationControllerBase {

    // ============= Data Types =============

    struct SwapData {
        address vaultedCurrency;
        uint256 lenderVaultedCurrencyAmount;
        uint256 borrowerVaultedCurrencyAmount;
        uint256 payableToVaultedCurrencyRatio;
    }

    // ============= Loan Origination =============

    function initializeSwap(
        LoanLibrary.LoanTerms calldata loanTerms,
        SwapData calldata swapData,
        address borrower,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 loanId);
}
