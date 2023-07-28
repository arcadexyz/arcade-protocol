// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./ILoanCore.sol";
import "./IOriginationController.sol";
import "./IFeeController.sol";

import "../rollover/v2-contracts/v2-interfaces/ILoanCoreV2.sol";
import "../rollover/v2-contracts/v2-interfaces/IRepaymentControllerV2.sol";

import "../external/interfaces/ILendingPool.sol";

interface IFlashLoanReceiver {
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool);

    // Function names defined by AAVE
    /* solhint-disable func-name-mixedcase */
    function ADDRESSES_PROVIDER() external view returns (ILendingPoolAddressesProvider);

    function LENDING_POOL() external view returns (ILendingPool);
    /* solhint-enable func-name-mixedcase */
}

interface IV2ToV3AAVERollover is IFlashLoanReceiver {
    event V2V3Rollover(address indexed lender, address indexed borrower, uint256 collateralTokenId, uint256 newLoanId);
    event Migration(address indexed oldLoanCore, uint256 oldLoanId, address indexed newLoanCore, uint256 newLoanId);

    /**
     * Holds parameters passed through flash loan
     * control flow that dictate terms of the new loan.
     * Contains a signature by lender for same terms.
     */
    struct OperationData {
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
        ILoanCoreV2 loanCoreV2;
        IERC721 borrowerNoteV2;
        IERC721 lenderNoteV2;
        IRepaymentControllerV2 repaymentControllerV2;
        IFeeController feeControllerV3;
        IOriginationController originationControllerV3;
        ILoanCore loanCoreV3;
        IERC721 borrowerNoteV3;
    }

    function rolloverLoan(
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