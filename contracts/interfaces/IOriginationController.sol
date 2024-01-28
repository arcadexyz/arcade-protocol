// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/LoanLibrary.sol";

interface IOriginationController {
    // ============= Data Types =============

    struct BorrowerData {
        address borrower;
        bytes callbackData;
    }

    struct SigProperties {
        uint160 nonce;
        uint96 maxUses;
    }

    enum Side {
        BORROW,
        LEND
    }

    struct Signature {
        uint8 v;
        bytes32 r;
        bytes32 s;
        bytes extraData;
    }

    // ================ Events ================

    event Approval(address indexed owner, address indexed signer, bool isApproved);

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

    // ================ Permission Management ================

    function approve(address signer, bool approved) external;

    function isApproved(address owner, address signer) external returns (bool);

    function isSelfOrApproved(address target, address signer) external returns (bool);

    // ============== Signature Verification ==============

    function recoverTokenSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        Side side
    ) external view returns (bytes32 sighash, address signer);

    function recoverItemsSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        Side side,
        bytes32 itemsHash
    ) external view returns (bytes32 sighash, address signer);
}
