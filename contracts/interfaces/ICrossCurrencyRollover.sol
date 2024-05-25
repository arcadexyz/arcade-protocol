// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/LoanLibrary.sol";

import "./IOriginationController.sol";

import "../external/interfaces/IFlashLoanRecipient.sol";

interface ICrossCurrencyRollover is IFlashLoanRecipient {
    event PausedStateChanged(bool isPaused);
    event CurrencyRollover(address indexed lender, address indexed borrower, uint256 collateralTokenId, uint256 newLoanId);

    // ================== Cross Currency Migration ==================

    function rolloverCrossCurrencyLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata loanTerms,
        address lender,
        address newCurrency,
        IOriginationController.Signature calldata sig,
        IOriginationController.SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates,
        uint24 poolFeeTier
    ) external;

    // ==================== OWNER OPS ====================

    function pause(bool _pause) external;
}