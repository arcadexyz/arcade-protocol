// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "../LoanLibraryV2.sol";

import "./IPromissoryNoteV2.sol";
import "./IFeeControllerV2.sol";

interface ILoanCoreV2 {
    // ================ Events =================

    event LoanCreated(LoanLibraryV2.LoanTerms terms, uint256 loanId);
    event LoanStarted(uint256 loanId, address lender, address borrower);
    event LoanRepaid(uint256 loanId);
    event LoanRolledOver(uint256 oldLoanId, uint256 newLoanId);
    event InstallmentPaymentReceived(uint256 loanId, uint256 repaidAmount, uint256 remBalance);
    event LoanClaimed(uint256 loanId);
    event FeesClaimed(address token, address to, uint256 amount);
    event SetFeeController(address feeController);
    event NonceUsed(address indexed user, uint160 nonce);

    // ============== Lifecycle Operations ==============

    function startLoan(
        address lender,
        address borrower,
        LoanLibraryV2.LoanTerms calldata terms
    ) external returns (uint256 loanId);

    function repay(uint256 loanId) external;

    function repayPart(
        uint256 _loanId,
        uint256 _currentMissedPayments,
        uint256 _paymentToPrincipal,
        uint256 _paymentToInterest,
        uint256 _paymentToLateFees,
        address _caller
    ) external;

    function claim(uint256 loanId, uint256 currentInstallmentPeriod) external;

    function rollover(
        uint256 oldLoanId,
        address borrower,
        address lender,
        LoanLibraryV2.LoanTerms calldata terms,
        uint256 _settledAmount,
        uint256 _amountToOldLender,
        uint256 _amountToLender,
        uint256 _amountToBorrower
    ) external returns (uint256 newLoanId);

    // ============== Nonce Management ==============

    function consumeNonce(address user, uint160 nonce) external;

    function cancelNonce(uint160 nonce) external;

    // ============== View Functions ==============

    function getLoan(uint256 loanId) external view returns (LoanLibraryV2.LoanData calldata loanData);

    function isNonceUsed(address user, uint160 nonce) external view returns (bool);

    function borrowerNote() external returns (IPromissoryNoteV2);

    function lenderNote() external returns (IPromissoryNoteV2);

    function feeController() external returns (IFeeControllerV2);
}
