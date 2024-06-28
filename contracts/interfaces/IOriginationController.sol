// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "./IOriginationControllerBase.sol";

import "../libraries/LoanLibrary.sol";

interface IOriginationController is IOriginationControllerBase {
    // ============= Data Types =============

    struct BorrowerData {
        address borrower;
        bytes callbackData;
    }

    // ============= Loan Origination =============

    function initializeLoan(
        LoanLibrary.LoanTerms calldata loanTerms,
        BorrowerData calldata borrowerData,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 loanId);

    function rolloverLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata loanTerms,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 newLoanId);
}
