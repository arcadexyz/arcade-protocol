// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/LoanLibrary.sol";

interface IOriginationController {
    // ============= Data Types =============

    struct Currency {
        bool isAllowed;
        uint256 minPrincipal;
    }

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

    struct RolloverAmounts {
        uint256 needFromBorrower;
        uint256 leftoverPrincipal;
        uint256 amountFromLender;
        uint256 amountToOldLender;
        uint256 amountToLender;
        uint256 amountToBorrower;
        uint256 interestAmount;
    }

    // ================ Events ================

    event Approval(address indexed owner, address indexed signer, bool isApproved);
    event SetAllowedVerifier(address indexed verifier, bool isAllowed);
    event SetAllowedCurrency(address indexed currency, bool isAllowed, uint256 minPrincipal);
    event SetAllowedCollateral(address indexed collateral, bool isAllowed);

    // ============= Loan Origination =============

    function initializeLoan(
       LoanLibrary.LoanTerms calldata loanTerms,
        BorrowerData calldata borrowerData,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 loanId);

    function initializeLoanWithPermit(
        LoanLibrary.LoanTerms calldata loanTerms,
        BorrowerData calldata borrowerData,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates,
        Signature calldata collateralSig,
        uint256 permitDeadline
    ) external returns (uint256 loanId);

    function rolloverLoan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata loanTerms,
        address lender,
        Signature calldata sig,
        SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 newLoanId);

    // ================== V3 Migration ==================

    function migrateV3Loan(
        uint256 oldLoanId,
        LoanLibrary.LoanTerms calldata loanTerms,
        address lender,
        Signature calldata sig,
        uint160 nonce,
        // add maxUses param!
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external returns (uint256 newLoanId);

    // ================ Permission Management ================

    function approve(address signer, bool approved) external;

    function isApproved(address owner, address signer) external returns (bool);

    function isSelfOrApproved(address target, address signer) external returns (bool);

    function isApprovedForContract(
        address target,
        Signature calldata sig,
        bytes32 sighash
    ) external returns (bool);

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

    // ============== Admin Operations ==============

    function setAllowedPayableCurrencies(address[] memory _tokenAddress, Currency[] calldata currencyData) external;

    function setAllowedCollateralAddresses(address[] memory _tokenAddress, bool[] calldata isAllowed) external;

    function setAllowedVerifiers(address[] calldata verifiers, bool[] calldata isAllowed) external;

    function isAllowedCurrency(address token) external view returns (bool);

    function isAllowedCollateral(address token) external view returns (bool);

    function isAllowedVerifier(address verifier) external view returns (bool);
}
