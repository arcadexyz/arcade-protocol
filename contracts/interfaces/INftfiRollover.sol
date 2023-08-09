// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "./IOriginationController.sol";
import "./IFeeController.sol";
import "./ILoanCore.sol";

import "../libraries/LoanLibrary.sol";

import "../external/interfaces/IFlashLoanRecipient.sol";
import "../external/NFTFI/loans/direct/loanTypes/DirectLoanFixedOffer.sol";

interface INftfiRollover is IFlashLoanRecipient {
    event NftfiRollover(
        address indexed lender,
        address indexed borrower,
        uint256 nftfiLoanId,
        uint256 newLoanId
    );

    struct OperationDataWithItems {
        uint256 loanId;
        address borrower;
        LoanLibrary.LoanTerms newLoanTerms;
        address lender;
        uint160 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
        LoanLibrary.Predicate[] itemPredicates;
    }

    struct OperationContracts {
        IFeeController feeController;
        IOriginationController originationController;
        ILoanCore loanCore;
        IERC721 borrowerNote;
    }

    function rolloverNftfiLoan(
        uint32 loanId,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        address lender,
        uint160 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external;

    function flushToken(IERC20 token, address to) external;

    function togglePause() external;
}
