// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/LoanLibraryV3.sol";

interface IOriginationControllerV3 {
    // ================ Data Types =============

    struct Currency {
        bool isAllowed;
        uint256 minPrincipal;
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
    }

    // ================ Events =================

    event Approval(address indexed owner, address indexed signer, bool isApproved);
    event SetAllowedVerifier(address indexed verifier, bool isAllowed);
    event SetAllowedCurrency(address indexed currency, bool isAllowed, uint256 minPrincipal);
    event SetAllowedCollateral(address indexed collateral, bool isAllowed);

    // ============== Origination Operations ==============

    function initializeLoan(
        LoanLibraryV3.LoanTerms calldata loanTerms,
        address borrower,
        address lender,
        Signature calldata sig,
        uint160 nonce
    ) external returns (uint256 loanId);

    function initializeLoanWithItems(
        LoanLibraryV3.LoanTerms calldata loanTerms,
        address borrower,
        address lender,
        Signature calldata sig,
        uint160 nonce,
        LoanLibraryV3.Predicate[] calldata itemPredicates
    ) external returns (uint256 loanId);

    function initializeLoanWithCollateralPermit(
        LoanLibraryV3.LoanTerms calldata loanTerms,
        address borrower,
        address lender,
        Signature calldata sig,
        uint160 nonce,
        Signature calldata collateralSig,
        uint256 permitDeadline
    ) external returns (uint256 loanId);

    function initializeLoanWithCollateralPermitAndItems(
        LoanLibraryV3.LoanTerms calldata loanTerms,
        address borrower,
        address lender,
        Signature calldata sig,
        uint160 nonce,
        Signature calldata collateralSig,
        uint256 permitDeadline,
        LoanLibraryV3.Predicate[] calldata itemPredicates
    ) external returns (uint256 loanId);

    function rolloverLoan(
        uint256 oldLoanId,
        LoanLibraryV3.LoanTerms calldata loanTerms,
        address lender,
        Signature calldata sig,
        uint160 nonce
    ) external returns (uint256 newLoanId);

    function rolloverLoanWithItems(
        uint256 oldLoanId,
        LoanLibraryV3.LoanTerms calldata loanTerms,
        address lender,
        Signature calldata sig,
        uint160 nonce,
        LoanLibraryV3.Predicate[] calldata itemPredicates
    ) external returns (uint256 newLoanId);

    // ================ Permission Management =================

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
        LoanLibraryV3.LoanTerms calldata loanTerms,
        Signature calldata sig,
        uint160 nonce,
        Side side
    ) external view returns (bytes32 sighash, address signer);

    function recoverItemsSignature(
        LoanLibraryV3.LoanTerms calldata loanTerms,
        Signature calldata sig,
        uint160 nonce,
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