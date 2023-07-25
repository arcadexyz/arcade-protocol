// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./ILoanCore.sol";
import "./IOriginationController.sol";
import "./IVaultFactory.sol";
import "./IFeeController.sol";

import "../rollover/v2-contracts/v2-interfaces/ILoanCoreV2.sol";
import "../rollover/v2-contracts/v2-interfaces/IRepaymentControllerV2.sol";

interface IFlashLoanRecipient {
    /**
     * @dev When `flashLoan` is called on the Vault, it invokes the `receiveFlashLoan` hook on the recipient.
     *
     * At the time of the call, the Vault will have transferred `amounts` for `tokens` to the recipient. Before this
     * call returns, the recipient must have transferred `amounts` plus `feeAmounts` for each token back to the
     * Vault, or else the entire flash loan will revert.
     *
     * `userData` is the same value passed in the `IVault.flashLoan` call.
     */
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

interface IVault {
    /**
     * @dev copied from @balancer-labs/v2-vault/contracts/interfaces/IVault.sol,
     *      which uses an incompatible compiler version. Only necessary selectors
     *      (flashLoan) included.
     */
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IV2ToV3BalancerRollover is IFlashLoanRecipient {
    event Rollover(address indexed lender, address indexed borrower, uint256 collateralTokenId, uint256 newLoanId);

    event Migration(address indexed oldLoanCore, address indexed newLoanCore, uint256 newLoanId);

    /**
     * The contract references needed to roll
     * over the loan. Other dependent contracts
     * (fee controller, promissory notes) can
     * be fetched from these contracts.
     */
    struct RolloverContractParams {
        ILoanCoreV2 sourceLoanCore;
        ILoanCore targetLoanCore;
        IRepaymentControllerV2 sourceRepaymentController;
        IOriginationController targetOriginationController;
        IERC721 collateral;
    }

    /**
     * Holds parameters passed through flash loan
     * control flow that dictate terms of the new loan.
     * Contains a signature by lender for same terms.
     */
    struct OperationData {
        RolloverContractParams contracts;
        uint256 loanId;
        LoanLibrary.LoanTerms newLoanTerms;
        address lender;
        uint160 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /**
     * Defines the contracts that should be used for a
     * flash loan operation.
     */
    struct OperationContracts {
        ILoanCoreV2 loanCore;
        IERC721 borrowerNote;
        IERC721 lenderNote;
        IFeeController feeController;
        IERC721 collateral;
        IRepaymentControllerV2 repaymentController;
        IOriginationController originationController;
        ILoanCore targetLoanCore;
        IERC721 targetBorrowerNote;
    }

    function rolloverLoan(
        RolloverContractParams calldata contracts,
        uint256 loanId,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        address lender,
        uint160 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function flushToken(IERC20 token, address to) external;
}