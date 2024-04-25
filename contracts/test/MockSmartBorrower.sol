// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "../interfaces/IExpressBorrow.sol";
import "../interfaces/IOriginationController.sol";

import "../libraries/LoanLibrary.sol";

/**
 * @notice Mock smart contract that implements IExpressBorrow::executeOperation
 *         for testing purposes.
 */
contract MockSmartBorrower is IExpressBorrow, ERC721Holder {
    address public immutable originationController;

    event OpExecuted();

    constructor(address _originationController) {
        originationController = _originationController;
    }

    function executeOperation(
        address, // loanOriginationCaller
        address, // lender
        LoanLibrary.LoanTerms calldata, // loanTerms
        bytes calldata // callbackData
    ) external virtual override {
        // This contract receives the borrowerNet amount of tokens from the OriginationController

        // After receiving tokens this contract can do whatever it wants with the tokens
        // For example:
        //     - Convert them to another token
        //     - Buy the NFT from the loanTerms off of a marketplace
        //     - Deposit into a yield farming protocol
        //     - etc...

        emit OpExecuted();
    }

    function initializeLoan(
        LoanLibrary.LoanTerms calldata loanTerms,
        IOriginationController.BorrowerData calldata borrowerData,
        address lender,
        IOriginationController.Signature calldata sig,
        IOriginationController.SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) public virtual {
        IOriginationController(originationController).initializeLoan(
            loanTerms,
            borrowerData,
            lender,
            sig,
            sigProperties,
            itemPredicates
        );
    }

    function approveSigner(address target, bool approved) external {
        IOriginationController(originationController).approve(target, approved);
    }

    function approveERC721(address token, address target, uint256 tokenId) external {
        IERC721(token).approve(target, tokenId);
    }
}

/**
 * @notice Mock smart contract that implements IExpressBorrow::executeOperation.
 *         This variant of the contract is used to test malicious callbacks targeting
 *         the OriginationController.
 */
contract MockSmartBorrowerTest is MockSmartBorrower {

    constructor(address _originationController) MockSmartBorrower(_originationController) {}

    function executeOperation(
        address, // loanOriginationCaller
        address, // lender
        LoanLibrary.LoanTerms calldata, // loanTerms
        bytes calldata callbackData // callbackData
    ) external override {
        // This contract receives the borrowerNet amount of tokens from the lender

        // Rollover the loan
        (bool success,) = originationController.call(callbackData);

        require(success, "MockSmartBorrowerTest: Operation failed");

        emit OpExecuted();
    }

    function initializeLoan(
        LoanLibrary.LoanTerms calldata loanTerms,
        IOriginationController.BorrowerData calldata borrowerData,
        address lender,
        IOriginationController.Signature calldata sig,
        IOriginationController.SigProperties calldata sigProperties,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) public override {
        IOriginationController(originationController).initializeLoan(
            loanTerms,
            borrowerData,
            lender,
            sig,
            sigProperties,
            itemPredicates
        );
    }
}
