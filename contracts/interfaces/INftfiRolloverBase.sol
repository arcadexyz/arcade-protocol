// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "./IOriginationController.sol";
import "./IFeeController.sol";
import "./ILoanCore.sol";

import "../external/interfaces/IFlashLoanRecipient.sol";
import "../external/nftfi/loans/direct/loanTypes/DirectLoanFixedOffer.sol";

interface INftfiRolloverBase is IFlashLoanRecipient {
    event NftfiRollover(
        address indexed lender,
        address indexed borrower,
        uint256 nftfiLoanId,
        uint256 newLoanId
    );

    event PausedStateChanged(bool isPaused);

    struct OperationContracts {
        IFeeController feeController;
        IOriginationController originationController;
        ILoanCore loanCore;
        IERC721 borrowerNote;
    }

    function flushToken(IERC20 token, address to) external;

    function togglePause() external;
}
