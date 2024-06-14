// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "./IOriginationControllerBase.sol";

import "../libraries/LoanLibrary.sol";

interface IOriginationControllerSTIRFRY is IOriginationControllerBase {

    // ============= Data Types =============

    struct StirfryData {
        address vaultedCurrency;
        uint256 lenderVaultedCurrencyAmount;
        uint256 borrowerVaultedCurrencyAmount;
        uint256 vaultedToPayableCurrencyRatio;
    }

    // ============= Loan Origination =============

    function initializeStirfryLoan(
        LoanLibrary.LoanTerms calldata loanTerms,
        StirfryData calldata stirfryData,
        address borrower,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 loanId);
}
