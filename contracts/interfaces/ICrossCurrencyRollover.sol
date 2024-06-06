// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/LoanLibrary.sol";
import "../libraries/OriginationLibrary.sol";

import "./IOriginationController.sol";

interface ICrossCurrencyRollover {
    // =========================== EVENTS ==========================
    event PausedStateChanged(bool isPaused);
    event CurrencyRollover(address indexed lender, address indexed borrower, uint256 collateralTokenId, uint256 newLoanId);

    // ================== CROSS CURRENCY ROLLOVER ==================
    function rolloverCrossCurrencyLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata loanTerms,
        address lender,
        IOriginationController.Signature calldata sig,
        IOriginationController.SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates,
        OriginationLibrary.SwapParameters calldata swapParams
    ) external;

    function calculateProratedInterestAmount(uint256 loanId) external returns (uint256);

    // ======================== OWNER OPS =========================
    function pause(bool _pause) external;
}