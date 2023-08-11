// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../interfaces/INftfiRollover.sol";

import "./base/NftfiRolloverBase.sol";

import {
    NR_UnknownCaller,
    NR_InsufficientFunds,
    NR_InsufficientAllowance,
    NR_Paused
} from "./errors/NftfiRolloverErrors.sol";

/**
 * @title NftfiToV3Rollover
 * @author Non-Fungible Technologies, Inc.
 *
 * This contract is used to rollover a loan from the NFTFI lending protocol to the Arcade
 * V3 lending protocol. The rollover mechanism takes out a flash loan for the maximumRepaymentAmount
 * of the nftfi loan from Balancer pool, repays the nftfi loan, and starts a new loan on V3.
 * This rollover contract can only used with specific loan terms signed by a lender not from a
 * collection wide offer. To perform a rollover with items, use the NftfiRolloverWithItems contract.
 *
 * This contract only works with ERC721 collateral.
 */
contract NftfiRollover is INftfiRollover, NftfiRolloverBase {
    using SafeERC20 for IERC20;

    constructor(IVault _vault, OperationContracts memory _opContracts) NftfiRolloverBase(_vault, _opContracts) {}

    /**
     * @notice Rollover a loan from NFTFI to V3. Validates new loan terms against the
     *         NFTFI terms. Takes out Flash Loan for maximumRepaymentAmount, repays NFTFI
     *         loan, and starts new loan on V3.
     *
     * @param loanId                 The ID of the NFTFI loan to be rolled over.
     * @param newLoanTerms           The terms of the new loan.
     * @param lender                 The address of the lender.
     * @param nonce                  The nonce for the signature.
     * @param v                      The v value of signature for new loan.
     * @param r                      The r value of signature for new loan.
     * @param s                      The s value of signature for new loan.
     */
    function rolloverNftfiLoan(
        uint32 loanId, // nftfi loanId
        LoanLibrary.LoanTerms calldata newLoanTerms,
        address lender,
        uint160 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (paused) revert NR_Paused();

        LoanData.LoanTerms memory loanTermsNftfi = _getLoanTermsNftfi(loanId);

        _validateRollover(loanTermsNftfi, newLoanTerms, loanId);

        {
            IERC20[] memory assets = new IERC20[](1);
            assets[0] = IERC20(loanTermsNftfi.loanERC20Denomination);

            uint256[] memory amounts = new uint256[](1);
            amounts[0] = loanTermsNftfi.maximumRepaymentAmount;

            bytes memory params = abi.encode(
                OperationData({
                    loanId: loanId,
                    borrower: loanTermsNftfi.borrower,
                    newLoanTerms: newLoanTerms,
                    lender: lender,
                    nonce: nonce,
                    v: v,
                    r: r,
                    s: s
                })
            );

            // Flash loan based on principal + interest
            VAULT.flashLoan(this, assets, amounts, params);
        }
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
        if (msg.sender != address(VAULT)) revert NR_UnknownCaller(msg.sender, address(VAULT));

        OperationData memory opData = abi.decode(params, (OperationData));
        _executeOperation(assets, amounts, feeAmounts, opData);
    }

    /**
     * @notice Executes repayment of NFTFI loan and initialization of new loan with lender
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
        uint256[] calldata premiums,
        OperationData memory opData
    ) internal {
        // Get NFTFI smartNFTId to look up lender promissoryNote and borrower obligationReceipt
        IDirectLoanCoordinator.Loan memory loanData = IDirectLoanCoordinator(loanCoordinator).getLoanData(
            uint32(opData.loanId)
        );
        uint64 smartNftId = loanData.smartNftId;

        address borrower = IERC721(IDirectLoanCoordinator(loanCoordinator).obligationReceiptToken()).ownerOf(
            smartNftId
        );
        address lender = IERC721(IDirectLoanCoordinator(loanCoordinator).promissoryNoteToken()).ownerOf(smartNftId);

        // Do accounting to figure out amount each party needs to receive
        (uint256 flashAmountDue, uint256 needFromBorrower, uint256 leftoverPrincipal) = _ensureFunds(
            amounts[0],
            premiums[0],
            uint256(
                IFeeController(feeController).getLendingFee(
                    // FL_01 - borrower origination fee
                    keccak256("BORROWER_ORIGINATION_FEE")
                )
            ),
            opData.newLoanTerms.principal
        );

        IERC20 asset = IERC20(assets[0]);

        if (needFromBorrower > 0) {
            if (asset.balanceOf(borrower) < needFromBorrower) {
                revert NR_InsufficientFunds(borrower, needFromBorrower, asset.balanceOf(opData.borrower));
            }
            if (asset.allowance(borrower, address(this)) < needFromBorrower) {
                revert NR_InsufficientAllowance(
                    borrower,
                    needFromBorrower,
                    asset.allowance(borrower, address(this))
                );
            }
        }

        {
            LoanData.LoanTerms memory loanTermsNftfi = _getLoanTermsNftfi(uint32(opData.loanId));

            _repayLoan(loanTermsNftfi, borrower, uint32(opData.loanId));

            uint256 newLoanId = _initializeNewLoan(borrower, opData.lender, opData);

            emit NftfiRollover(
                lender,
                borrower,
                uint32(opData.loanId), // NftFi loanId
                newLoanId
            );
        }

        if (leftoverPrincipal > 0) {
            asset.safeTransfer(borrower, leftoverPrincipal);
        } else if (needFromBorrower > 0) {
            asset.safeTransferFrom(borrower, address(this), needFromBorrower);
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
    function _initializeNewLoan(
        address borrower,
        address lender,
        OperationData memory opData
    ) internal returns (uint256) {
        // approve originationController
        IERC721(opData.newLoanTerms.collateralAddress).approve(address(loanCore), opData.newLoanTerms.collateralId);

        // start new loan
        // stand in for borrower to meet OriginationController's requirements
        uint256 newLoanId = IOriginationController(originationController).initializeLoan(
            opData.newLoanTerms,
            address(this),
            lender,
            IOriginationController.Signature({ v: opData.v, r: opData.r, s: opData.s, extraData: "0x" }),
            opData.nonce
        );

        IERC721(address(borrowerNote)).safeTransferFrom(address(this), borrower, newLoanId);

        return newLoanId;
    }

    receive() external payable {}
}