// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/OriginationLibrary.sol";

interface IOriginationControllerRefinance {
    // ================ Events ===================

    event SetMinimumInterestChange(uint256 newMinimumInterestChange);

    // ============= Loan Refinancing ============

    function refinanceLoan(
        uint256 loanId,
        LoanLibrary.LoanTerms calldata newTerms
    ) external returns (uint256 newLoanId);

    // ================== Admin ==================

    function setMinimumInterestChange(uint256 _minimumInterestChange) external;

}
