// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../external/interfaces/ILendingPool.sol";
import "../interfaces/IV2ToV3BalancerRollover.sol";
import "../interfaces/IRepaymentController.sol";

import {
    R_UnknownCaller,
    R_InsufficientFunds,
    R_InsufficientAllowance,
    R_FundsConflict,
    R_NotCollateralOwner,
    R_CallerNotBorrower,
    R_CurrencyMismatch,
    R_CollateralMismatch,
    R_CollateralIdMismatch,
    R_NoTokenBalance,
    R_Paused
} from "./RolloverErrors.sol";

/**
 * @title V2ToV3BalancerRollover
 * @author Non-Fungible Technologies, Inc.
 *
 * This contract is used to rollover a loan from the legacy V2 lending protocol to the new
 * V3 lending protocol. The rollover mechanism takes out a flash loan for the principal +
 * interest of the old loan from Balancer pool, repays the V2 loan, and starts a new loan on V3.
 * The V3 loan can be started with either specific loan terms signed by a lender or from a
 * collection wide offer signed by a lender.
 *
 * It is required that the V2 protocol has zero fees enabled. This contract only works with
 * ERC721 collateral.
 */
contract V2ToV3BalancerRollover is IV2ToV3BalancerRollover, ReentrancyGuard, ERC721Holder, Ownable {
    using SafeERC20 for IERC20;

    // Balancer vault contract
    /* solhint-disable var-name-mixedcase */
    IVault public immutable VAULT; // 0xBA12222222228d8Ba445958a75a0704d566BF2C8

    /// @notice V2 lending protocol contract references
    ILoanCoreV2 public constant loanCoreV2 = ILoanCoreV2(0x81b2F8Fc75Bab64A6b144aa6d2fAa127B4Fa7fD9);
    IERC721 public constant borrowerNoteV2 = IERC721(0x337104A4f06260Ff327d6734C555A0f5d8F863aa);
    IERC721 public constant lenderNoteV2 = IERC721(0x349A026A43FFA8e2Ab4c4e59FCAa93F87Bd8DdeE);
    IRepaymentControllerV2 public constant repaymentControllerV2 =
        IRepaymentControllerV2(0xb39dAB85FA05C381767FF992cCDE4c94619993d4);

    /// @notice V3 lending protocol contract references
    IFeeController public immutable feeControllerV3;
    IOriginationController public immutable originationControllerV3;
    ILoanCore public immutable loanCoreV3;
    IERC721 public immutable borrowerNoteV3;

    /// @notice state variable for pausing the contract
    bool public paused = false;

    constructor(IVault _vault, OperationContracts memory _opContracts) {
        // Set Balancer vault address
        VAULT = _vault;

        // Set lending protocol contract references
        feeControllerV3 = IFeeController(_opContracts.feeControllerV3);
        originationControllerV3 = IOriginationController(_opContracts.originationControllerV3);
        loanCoreV3 = ILoanCore(_opContracts.loanCoreV3);
        borrowerNoteV3 = IERC721(_opContracts.borrowerNoteV3);
    }

    /**
     * @notice Rollover a loan from V2 to V3. Validates new loan terms against the old terms.
     *         Takes out Flash Loan for principal + interest, repays old loan, and starts new 
     *         loan on V3.
     *
     * @param loanId                 The ID of the loan to be rolled over.
     * @param newLoanTerms           The terms of the new loan.
     * @param lender                 The address of the lender.
     * @param nonce                  The nonce of the new loan.
     * @param v                      The v value of signature for new loan.
     * @param r                      The r value of signature for new loan.
     * @param s                      The s value of signature for new loan.
     */
    function rolloverLoan(
        uint256 loanId,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        address lender,
        uint160 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external override {
        if(paused == true) revert R_Paused();

        LoanLibraryV2.LoanTerms memory loanTerms = loanCoreV2.getLoan(loanId).terms;

        {
            _validateRollover(
                loanTerms,
                newLoanTerms,
                loanId // same as borrowerNoteId
            );
        }

        {
            IERC20[] memory assets = new IERC20[](1);
            assets[0] = IERC20(loanTerms.payableCurrency);

            uint256[] memory amounts = new uint256[](1);
            amounts[0] = loanTerms.principal + (loanTerms.principal * loanTerms.interestRate / 1 ether / 1e4);

            bytes memory params = abi.encode(
                OperationData(
                    {
                        loanId: loanId,
                        newLoanTerms: newLoanTerms,
                        lender: lender,
                        nonce: nonce,
                        v: v,
                        r: r,
                        s: s
                    }
                )
            );

            // encode packed with items trigger - false
            params = abi.encodePacked(params, uint(0));

            // Flash loan based on principal + interest
            VAULT.flashLoan(this, assets, amounts, params);
        }
    }

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

        {
            _validateRollover(
                loanTerms,
                newLoanTerms,
                loanId // same as borrowerNoteId
            );
        }

        {
            IERC20[] memory assets = new IERC20[](1);
            assets[0] = IERC20(loanTerms.payableCurrency);

            uint256[] memory amounts = new uint256[](1);
            amounts[0] = loanTerms.principal + (loanTerms.principal * loanTerms.interestRate / 1 ether / 1e4);

            bytes memory params = abi.encode(
                OperationDataWithItems(
                    {
                        loanId: loanId,
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

            // encode packed with items trigger - true
            params = abi.encodePacked(params, uint(1));

            // Flash loan based on principal + interest
            VAULT.flashLoan(this, assets, amounts, params);
        }
    }

    /**
     * @notice Callback function for flash loan. This function looks at the last byte in
     *         the encoded params to determine which _executeOperation function to use to
     *         rollover loan from V2 to V3. The caller of this function must be the lending pool.
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
    ) external override nonReentrant {
        if (msg.sender != address(VAULT)) revert R_UnknownCaller(msg.sender, address(VAULT));

        // Extract the last byte from params and convert it to boolean
        bool withItemsBool = params[params.length - 1] == 0x01; 

        // Call the appropriate _executeOperation function based on with items boolean
        if (withItemsBool == true) {
            (OperationDataWithItems memory opData, ) = abi.decode(params, (OperationDataWithItems, uint));
            _executeOperationWithItems(assets, amounts, feeAmounts, opData);
        } else {
            (OperationData memory opData, ) = abi.decode(params, (OperationData, uint));
            _executeOperation(assets, amounts, feeAmounts, opData);
        }
    }

    /**
     * @notice Executes repayment of old loan and initialization of new loan. Any funds
     *         that are not covered by closing out the old loan must be covered by the borrower.
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
        OperationData memory opData
    ) internal {
        // Get loan details
        LoanLibraryV2.LoanData memory loanData = loanCoreV2.getLoan(opData.loanId);
        address borrower = borrowerNoteV2.ownerOf(opData.loanId);
        address lender = lenderNoteV2.ownerOf(opData.loanId);

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
            if (asset.balanceOf(borrower) < needFromBorrower) {
                revert R_InsufficientFunds(borrower, needFromBorrower, asset.balanceOf(borrower));
            }
            if (asset.allowance(borrower, address(this)) < needFromBorrower) {
                revert R_InsufficientAllowance(borrower, needFromBorrower, asset.allowance(borrower, address(this)));
            }
        }

        _repayLoan(loanData, opData.loanId, borrower);

        {
            uint256 newLoanId = _initializeNewLoan(
                borrower,
                opData.lender,
                opData
            );

            emit V2V3Rollover(
                lender,
                borrower,
                loanData.terms.collateralId,
                newLoanId
            );
        }

        if (leftoverPrincipal > 0) {
            asset.safeTransfer(borrower, leftoverPrincipal);
        } else if (needFromBorrower > 0) {
            asset.safeTransferFrom(borrower, address(this), needFromBorrower);
        }

        // Make flash loan repayment
        // Balancer requires a transfer back the vault
        asset.transfer(address(VAULT), flashAmountDue);
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
    function _executeOperationWithItems(
        IERC20[] calldata assets,
        uint256[] calldata amounts,
        uint256[] memory premiums,
        OperationDataWithItems memory opData
    ) internal {
        // Get loan details
        LoanLibraryV2.LoanData memory loanData = loanCoreV2.getLoan(opData.loanId);
        address borrower = borrowerNoteV2.ownerOf(opData.loanId);
        address lender = lenderNoteV2.ownerOf(opData.loanId);

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
            if (asset.balanceOf(borrower) < needFromBorrower) {
                revert R_InsufficientFunds(borrower, needFromBorrower, asset.balanceOf(borrower));
            }
            if (asset.allowance(borrower, address(this)) < needFromBorrower) {
                revert R_InsufficientAllowance(borrower, needFromBorrower, asset.allowance(borrower, address(this)));
            }
        }

        _repayLoan(loanData, opData.loanId, borrower);

        {
            uint256 newLoanId = _initializeNewLoanWithItems(
                borrower,
                opData.lender,
                opData
            );

            emit V2V3Rollover(
                lender,
                borrower,
                loanData.terms.collateralId,
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
     * @notice Helper function to calculate total flash loan amounts. This function will return
     *         the total amount due back to the lending pool. The amount that needs to be paid by
     *         the borrower, in the case that the new loan does not cover the flashAmountDue. Lastly,
     *         the amount that will be sent back to the borrower, in the case that the new loan
     *         covers more than the flashAmountDue.
     *
     * @param amount                  The amount that was borrowed in Flash Loan.
     * @param premium                 The fees that are due back to the lending pool.
     * @param originationFee          The origination fee for the new loan.
     * @param newPrincipal            The principal of the new loan.
     *
     * @return flashAmountDue         The total amount due back to the lending pool.
     * @return needFromBorrower       The amount borrower owes if new loan cannot repay flash loan.
     * @return leftoverPrincipal      The amount to send to borrower if new loan amount is more than
     *                                amount required to repay flash loan.
     */
    function _ensureFunds(
        uint256 amount,
        uint256 premium,
        uint256 originationFee,
        uint256 newPrincipal
    ) internal pure returns (uint256 flashAmountDue, uint256 needFromBorrower, uint256 leftoverPrincipal) {
        // total amount due to flash loan contract
        flashAmountDue = amount + premium;
        // amount that will be received when starting the new loan
        uint256 willReceive = newPrincipal - ((newPrincipal * originationFee) / 1e4);

        if (flashAmountDue > willReceive) {
            // Not enough - have borrower pay the difference
            needFromBorrower = flashAmountDue - willReceive;
        } else if (willReceive > flashAmountDue) {
            // Too much - will send extra to borrower
            leftoverPrincipal = willReceive - flashAmountDue;
        }

        // Either leftoverPrincipal or needFromBorrower should be 0
        if (leftoverPrincipal != 0 && needFromBorrower != 0) {
            revert R_FundsConflict(leftoverPrincipal, needFromBorrower);
        }
    }

    /**
     * @notice Helper function to repay the loan. Takes the borrowerNote from the borrower, approves
     *         the V2 repayment controller to spend the payable currency received from flash loan.
     *         Repays the loan, and ensures this contract holds the collateral after the loan is repaid.
     *
     * @param loanData                 The loan data for the loan to be repaid.
     * @param borrowerNoteId           ID of the borrowerNote for the loan to be repaid.
     * @param borrower                 The address of the borrower.
     */
    function _repayLoan(
        LoanLibraryV2.LoanData memory loanData,
        uint256 borrowerNoteId,
        address borrower
    ) internal {
        // take BorrowerNote from borrower so that this contract receives collateral
        // borrower must approve this withdrawal
        borrowerNoteV2.transferFrom(borrower, address(this), borrowerNoteId);

        // approve repayment
        uint256 totalRepayment = repaymentControllerV2.getFullInterestAmount(
            loanData.terms.principal,
            loanData.terms.interestRate
        );
        IERC20(loanData.terms.payableCurrency).approve(
            address(repaymentControllerV2),
            totalRepayment
        );

        // repay loan
        repaymentControllerV2.repay(borrowerNoteId);

        // contract now has collateral but has lost funds
        address collateralOwner = IERC721(loanData.terms.collateralAddress).ownerOf(loanData.terms.collateralId);
        if (collateralOwner != address(this)) revert R_NotCollateralOwner(collateralOwner);
    }

    /**
     * @notice Helper function to initialize the new loan. Approves the V3 Loan Core contract
     *         to take the collateral, then starts the new loan. Once the new loan is started,
     *         the borrowerNote is sent to the borrower.
     *
     * @param borrower                 The address of the borrower.
     * @param lender                   The address of the new lender.
     * @param opData                   The data used to initiate new V3 loan.
     *
     * @return newLoanId               V3 loanId for the new loan that is started.
     */
    function _initializeNewLoan(
        address borrower,
        address lender,
        OperationData memory opData
    ) internal returns (uint256) {
        uint256 collateralId = opData.newLoanTerms.collateralId;

        // approve targetLoanCore to take collateral
        IERC721(opData.newLoanTerms.collateralAddress).approve(address(loanCoreV3), collateralId);

        // start new loan
        // stand in for borrower to meet OriginationController's requirements
        uint256 newLoanId = originationControllerV3.initializeLoan(
            opData.newLoanTerms,
            address(this),
            lender,
            IOriginationController.Signature({
                v: opData.v,
                r: opData.r,
                s: opData.s,
                extraData: "0x"
            }),
            opData.nonce
        );

        // send the borrowerNote for the new V3 loan to the borrower
        borrowerNoteV3.safeTransferFrom(address(this), borrower, newLoanId);

        return newLoanId;
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

    /**
     * @notice Validates that the rollover is valid. The borrower from the old loan must be the caller.
     *         The new loan must have the same currency as the old loan. The new loan must use the same
     *         collateral as the old loan. If any of these conditionals are not met, the
     *         transaction will revert.
     *
     * @param sourceLoanTerms           The terms of the V2 loan.
     * @param newLoanTerms              The terms of the V3 loan.
     * @param borrowerNoteId            The ID of the borrowerNote for the old loan.
     */
    function _validateRollover(
        LoanLibraryV2.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms memory newLoanTerms,
        uint256 borrowerNoteId
    ) internal view {
        address borrower = borrowerNoteV2.ownerOf(borrowerNoteId);

        if (borrower != msg.sender) revert R_CallerNotBorrower(msg.sender, borrower);
        if (sourceLoanTerms.payableCurrency != newLoanTerms.payableCurrency) {
            revert R_CurrencyMismatch(sourceLoanTerms.payableCurrency, newLoanTerms.payableCurrency);
        }
        if (sourceLoanTerms.collateralAddress != newLoanTerms.collateralAddress) {
            revert R_CollateralMismatch(sourceLoanTerms.collateralAddress, newLoanTerms.collateralAddress);
        }
        if (sourceLoanTerms.collateralId != newLoanTerms.collateralId) {
            revert R_CollateralIdMismatch(sourceLoanTerms.collateralId, newLoanTerms.collateralId);
        }
    }

    /**
     * @notice Function to be used by the contract owner to pause the contract.
     *
     * @dev This function is only to be used if a vulnerability is found or the contract
     *      is no longer being used.
     */
    function togglePause() external onlyOwner {
        paused = !paused;
    }

    /**
     * @notice Function to be used by the contract owner to withdraw any ERC20 tokens that
     *         are sent to the contract and get stuck.
     */
    function flushToken(IERC20 token, address to) external override onlyOwner {
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert R_NoTokenBalance();

        token.transfer(to, balance);
    }

    receive() external payable {}
}