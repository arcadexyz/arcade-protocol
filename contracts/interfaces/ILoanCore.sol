// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "../libraries/LoanLibrary.sol";

import "./IPromissoryNote.sol";
import "./ILoanCore.sol";

interface ILoanCore {

    // ================ Data Types =================

    struct AffiliateSplit {
        address affiliate;
        uint96 splitBps;
    }

    struct NoteReceipt {
        address token;
        uint256 amount;
    }

    // ================ Events =================

    event LoanCreated(LoanLibrary.LoanTerms terms, uint256 loanId);
    event LoanStarted(uint256 loanId, address lender, address borrower);
    event LoanRepaid(uint256 loanId);
    event ForceRepay(uint256 loanId);
    event LoanRolledOver(uint256 oldLoanId, uint256 newLoanId);
    event LoanClaimed(uint256 loanId);
    event NonceUsed(address indexed user, uint160 nonce);

    event FundsWithdrawn(address indexed token, address indexed caller, address indexed to, uint256 amount);
    event NoteRedeemed(address indexed token, address indexed caller, address indexed to, uint256 tokenId, uint256 amount);
    event AffiliateSet(bytes32 indexed code, address indexed affiliate, uint96 splitBps);

    // ============== Lifecycle Operations ==============

    function startLoan(
        address lender,
        address borrower,
        LoanLibrary.LoanTerms calldata terms,
        bytes32 affiliateCode,
        uint256 _amountFromLender,
        uint256 _amountToBorrower
    ) external returns (uint256 loanId);

    function repay(
        uint256 loanId,
        address payer,
        uint256 _amountFromPayer,
        uint256 _amountToLender
    ) external;

    function forceRepay(
        uint256 loanId,
        address payer,
        uint256 _amountFromPayer,
        uint256 _amountToLender
    ) external;

    function claim(
        uint256 loanId,
        uint256 _amountFromLender
    ) external;

    function rollover(
        uint256 oldLoanId,
        address borrower,
        address lender,
        LoanLibrary.LoanTerms calldata terms,
        uint256 _settledAmount,
        uint256 _amountToOldLender,
        uint256 _amountToLender,
        uint256 _amountToBorrower
    ) external returns (uint256 newLoanId);

    // ============== Nonce Management ==============

    function consumeNonce(address user, uint160 nonce) external;

    function cancelNonce(uint160 nonce) external;

    // ============== Fees ==============

    function setAffiliateSplits(bytes32[] calldata codes, AffiliateSplit[] calldata splits) external;

    function withdraw(address token, uint256 amount, address to) external;

    function withdrawProtocolFees(address token, address to) external;

    function redeemNote(uint256 loanId, address to) external;

    // ============== View Functions ==============

    function getLoan(uint256 loanId) external view returns (LoanLibrary.LoanData calldata loanData);

    function isNonceUsed(address user, uint160 nonce) external view returns (bool);

    function borrowerNote() external returns (IPromissoryNote);

    function lenderNote() external returns (IPromissoryNote);
}
