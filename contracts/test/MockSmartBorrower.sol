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

    event opExecuted();

    constructor(address _originationController) {
        originationController = _originationController;
    }

    function executeOperation(
        address, // loanOriginationCaller
        address, // lender
        LoanLibrary.LoanTerms calldata, // loanTerms
        uint256, // borrowerNet
        bytes calldata // callback params
    ) external virtual override {
        // This contract receives the borrowerNet amount of tokens from the lender

        // This contract can do whatever it wants with the tokens
        // For example:
        //     - convert them to another token,
        //     - buy the NFT from the loanTerms off of a marketplace
        //     - deposit into a yield farming protocol
        //     - etc.

        emit opExecuted();
    }

    function approveSigner(address target, bool approved) external {
        IOriginationController(originationController).approve(target, approved);
    }

    function approveERC721(address token, address target, uint256 tokenId) external {
        IERC721(token).approve(target, tokenId);
    }
}

contract MockSmartBorrowerTest is MockSmartBorrower {

    constructor(address _originationController) MockSmartBorrower(_originationController) {}

    function executeOperation(
        address, // loanOriginationCaller
        address, // lender
        LoanLibrary.LoanTerms calldata, // loanTerms
        uint256, // borrowerNet
        bytes calldata callbackData // callback params
    ) external override {
        // This contract receives the borrowerNet amount of tokens from the lender

        // Rollover the loan
        (bool success,) = originationController.call(callbackData);

        require(success, "MockSmartBorrowerRollover: Operation failed");

        emit opExecuted();
    }

    function initializeLoan(
        LoanLibrary.LoanTerms calldata loanTerms,
        IOriginationController.BorrowerData calldata borrowerData,
        address lender,
        IOriginationController.Signature calldata sig,
        uint160 nonce,
        LoanLibrary.Predicate[] calldata itemPredicates,
        IOriginationController.Signature calldata collateralSig,
        uint256 permitDeadline
    ) public {
        IOriginationController(originationController).initializeLoan(
            loanTerms,
            borrowerData,
            lender,
            sig,
            nonce,
            itemPredicates,
            collateralSig,
            permitDeadline
        );
    }
}
