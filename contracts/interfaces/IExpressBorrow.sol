// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/LoanLibrary.sol";

interface IExpressBorrow {
    function executeOperation(
        address loanOriginationCaller,
        address lender,
        LoanLibrary.LoanTerms calldata loanTerms,
        uint256 borrowerNet,
        bytes calldata params
    ) external;
}