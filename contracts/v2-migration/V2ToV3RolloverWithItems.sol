// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "./base/V2ToV3RolloverBase.sol";

import "../interfaces/IV2ToV3RolloverWithItems.sol";

import {
    R_UnknownCaller,
    R_InsufficientFunds,
    R_InsufficientAllowance,
    R_Paused
} from "./errors/RolloverErrors.sol";

/**
 * @title V2ToV3RolloverWithItems
 * @author Non-Fungible Technologies, Inc.
 *
 * This contract is used to rollover a loan from the legacy V2 lending protocol to the new
 * V3 lending protocol. The rollover mechanism takes out a flash loan for the principal +
 * interest of the old loan from Balancer pool, repays the V2 loan, and starts a new loan on V3.
 * This migration contract can be used with a collection wide offer signed by a lender. For
 * rollover with standard LoanTerms use V2ToV3Rollover contract.
 *
 * It is required that the V2 protocol has zero fees enabled. This contract only works with
 * ERC721 collateral.
 */
contract V2ToV3RolloverWithItems is IV2ToV3RolloverWithItems, V2ToV3RolloverBase {
    using SafeERC20 for IERC20;

    constructor(IVault _vault, OperationContracts memory _opContracts) V2ToV3RolloverBase(_vault, _opContracts) {}

    /**
     * @notice Rollover a loan from V2 to V3 using a collection wide offer. Validates new
     *         loan terms against the old terms. Takes out Flash Loan for principal + interest,
     *         repays old loan, and starts new loan on V3.
     *
     * @param loanId                 The ID of the V2 loan to be rolled over.
     * @param newLoanTerms           The terms of the new loan.
     * @param lender                 The address of the lender.
     * @param nonce                  The nonce for the signature.
     * @param v                      The v value of signature for new loan.
     * @param r                      The r value of signature for new loan.
     * @param s                      The s value of signature for new loan.
     * @param itemPredicates         The item predicates specified by lender for new loan.
     */
    function rolloverLoanWithItems(
        uint256 loanId,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        address lender,
        uint160 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external override {
        if(paused == true) revert R_Paused();

        LoanLibraryV2.LoanTerms memory loanTerms = loanCoreV2.getLoan(loanId).terms;

        ( address borrower ) = _validateRollover(
            loanTerms,
            newLoanTerms,
            loanId // same as borrowerNoteId
        );

        IERC20[] memory assets = new IERC20[](1);
        assets[0] = IERC20(loanTerms.payableCurrency);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = repaymentControllerV2.getFullInterestAmount(loanTerms.principal, loanTerms.interestRate);

        bytes memory params = abi.encode(
            OperationDataWithItems(
                {
                    loanId: loanId,
                    borrower: borrower,
                    newLoanTerms: newLoanTerms,
                    lender: lender,
                    nonce: nonce,
                    v: v,
                    r: r,
                    s: s,
                    itemPredicates: itemPredicates
                }
            )
        );

        // Flash loan based on principal + interest
        VAULT.flashLoan(this, assets, amounts, params);
    }

    /**
     * @notice Callback function for flash loan.
     *
     * @dev The caller of this function must be the lending pool.
     *
     * @param assets                 The ERC20 address that was borrowed in Flash Loan.
     * @param amounts                The amount that was borrowed in Flash Loan.
     * @param feeAmounts             The fees that are due to the lending pool.
     * @param params                 The data to be executed after receiving Flash Loan.
     */
    function receiveFlashLoan(
        IERC20[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata params
    ) external nonReentrant {
        if (msg.sender != address(VAULT)) revert R_UnknownCaller(msg.sender, address(VAULT));

        OperationDataWithItems memory opData = abi.decode(params, (OperationDataWithItems));
        _executeOperation(assets, amounts, feeAmounts, opData);
    }

    /**
     * @notice Executes repayment of old loan and initialization of new loan with lender
     *         specified item predicates. Any funds that are not covered by closing out
     *         the old loan must be covered by the borrower.
     *
     * @param assets                 The ERC20 that was borrowed in Flash Loan.
     * @param amounts                The amount that was borrowed in Flash Loan.
     * @param premiums               The fees that are due back to the lending pool.
     * @param opData                 The data to be executed after receiving Flash Loan.                 
     */
    function _executeOperation(
        IERC20[] calldata assets,
        uint256[] calldata amounts,
        uint256[] memory premiums,
        OperationDataWithItems memory opData
    ) internal {
        // Get loan details
        LoanLibraryV2.LoanData memory loanData = loanCoreV2.getLoan(opData.loanId);

        // Do accounting to figure out amount each party needs to receive
        (uint256 flashAmountDue, uint256 needFromBorrower, uint256 leftoverPrincipal) = _ensureFunds(
            amounts[0], // principal + interest
            premiums[0], // flash loan fee
            uint256(
                feeControllerV3.getLendingFee(
                    // FL_01 - borrower origination fee
                    keccak256("BORROWER_ORIGINATION_FEE")
                )
            ),
            opData.newLoanTerms.principal // new loan terms principal
        );

        IERC20 asset = assets[0];

        if (needFromBorrower > 0) {
            if (asset.balanceOf(opData.borrower) < needFromBorrower) {
                revert R_InsufficientFunds(opData.borrower, needFromBorrower, asset.balanceOf(opData.borrower));
            }
            if (asset.allowance(opData.borrower, address(this)) < needFromBorrower) {
                revert R_InsufficientAllowance(
                    opData.borrower,
                    needFromBorrower,
                    asset.allowance(opData.borrower, address(this))
                );
            }
        }

        _repayLoan(loanData, opData.loanId, opData.borrower);

        {
            uint256 newLoanId = _initializeNewLoanWithItems(
                opData.borrower,
                opData.lender,
                opData
            );

            emit V2V3Rollover(
                opData.lender,
                opData.borrower,
                loanData.terms.collateralId,
                newLoanId
            );
        }

        if (leftoverPrincipal > 0) {
            asset.safeTransfer(opData.borrower, leftoverPrincipal);
        } else if (needFromBorrower > 0) {
            asset.safeTransferFrom(opData.borrower, address(this), needFromBorrower);
        }

        // Make flash loan repayment
        // Balancer requires a transfer back to the vault
        asset.transfer(address(VAULT), flashAmountDue);
    }

    /**
     * @notice Helper function to initialize the new loan using a collection wide offer. Approves
     *         the V3 Loan Core contract to take the collateral, then starts the new loan. Once
     *         the new loan is started, the borrowerNote is sent to the borrower.
     *
     * @param borrower                 The address of the borrower.
     * @param lender                   The address of the new lender.
     * @param opData                   The data used to initialize new V3 loan with items.
     *
     * @return newLoanId               V3 loanId for the new loan that is started.
     */
    function _initializeNewLoanWithItems(
        address borrower,
        address lender,
        OperationDataWithItems memory opData
    ) internal returns (uint256) {
        uint256 collateralId = opData.newLoanTerms.collateralId;

        // approve targetLoanCore to take collateral
        IERC721(opData.newLoanTerms.collateralAddress).approve(address(loanCoreV3), collateralId);

        // start new loan
        // stand in for borrower to meet OriginationController's requirements
        uint256 newLoanId = originationControllerV3.initializeLoanWithItems(
            opData.newLoanTerms,
            address(this),
            lender,
            IOriginationController.Signature({
                v: opData.v,
                r: opData.r,
                s: opData.s,
                extraData: "0x"
            }),
            opData.nonce,
            opData.itemPredicates
        );

        // send the borrowerNote for the new V3 loan to the borrower
        borrowerNoteV3.safeTransferFrom(address(this), borrower, newLoanId);

        return newLoanId;
    }

    receive() external payable {}
}
