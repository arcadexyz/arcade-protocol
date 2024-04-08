// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/OriginationLibrary.sol";

interface IRefinanceController {
    // ============= Loan Refinancing ============

    function refinanceLoan(
        uint256 loanId,
        LoanLibrary.LoanTerms calldata newTerms,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 newLoanId);
}
