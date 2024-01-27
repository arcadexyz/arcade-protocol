// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/LoanLibrary.sol";

import "./IOriginationController.sol";

import "../external/interfaces/IFlashLoanRecipient.sol";

interface IMigrationBase is IFlashLoanRecipient {
    event PausedStateChanged(bool isPaused);
    event V3V4Rollover(address indexed lender, address indexed borrower, uint256 collateralTokenId, uint256 newLoanId);

    // ================== V3 Migration ==================

    function migrateV3Loan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata loanTerms,
        address lender,
        IOriginationController.Signature calldata sig,
        IOriginationController.SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external;

    // ==================== OWNER OPS ====================

    function pause(bool _pause) external;
}