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

/**
 * @title V2ToV3BalancerRollover
 * @author Non-Fungible Technologies, Inc.
 *
 * This contract is used to rollover a loan from V2 to V3. It takes out a flash loan for the
 * principal + interest of the old loan, repays the old loan, and starts a new loan on V3.
 *
 * It is required that the V2 protocol has zero fees enabled. This contract only works with
 * ERC721 collateral.
 */
contract V2ToV3BalancerRollover is IV2ToV3BalancerRollover, ReentrancyGuard, ERC721Holder, Ownable {
    using SafeERC20 for IERC20;

    // Balancer vault contract
    /* solhint-disable var-name-mixedcase */
    IVault public immutable VAULT; // 0xBA12222222228d8Ba445958a75a0704d566BF2C8

    /// @notice contract references needed to rollover the loan from V2 to V3
    ILoanCoreV2 public immutable loanCoreV2;
    IERC721 public immutable borrowerNoteV2;
    IERC721 public immutable lenderNoteV2;
    IRepaymentControllerV2 public immutable repaymentControllerV2;
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
        loanCoreV2 = ILoanCoreV2(_opContracts.loanCoreV2);
        borrowerNoteV2 = IERC721(_opContracts.borrowerNoteV2);
        lenderNoteV2 = IERC721(_opContracts.lenderNoteV2);
        repaymentControllerV2 = IRepaymentControllerV2(_opContracts.repaymentControllerV2);
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

            // Flash loan based on principal + interest
            VAULT.flashLoan(this, assets, amounts, params);
        }
    }

    /**
     * @notice Callback function for flash loan. Calls _executeOperation to rollover loan from V2 to V3.
     *         The caller of this function must be the lending pool.
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
        require(msg.sender == address(VAULT), "unknown callback sender");

        _executeOperation(assets, amounts, feeAmounts, abi.decode(params, (OperationData)));
    }

    /**
     * @notice Executes repayment of old loan and initialization of new loan. Any funds
     *         that are not covered by closing out the old loan must be covered by the borrower.
     *
     * @param assets                 The ERC20 address that was borrowed in Flash Loan.
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
            require(asset.balanceOf(borrower) >= needFromBorrower, "borrower cannot pay");
            require(asset.allowance(borrower, address(this)) >= needFromBorrower, "lacks borrower approval");
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

            emit Migration(address(loanCoreV2), opData.loanId, address(loanCoreV3), newLoanId);
        }

        if (leftoverPrincipal > 0) {
            asset.safeTransfer(borrower, leftoverPrincipal);
        } else if (needFromBorrower > 0) {
            asset.safeTransferFrom(borrower, address(this), needFromBorrower);
        }

        // Make flash loan repayment
        // Unlike for AAVE, Balancer requires a transfer
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
        // amount that will be recieved when starting the new loan
        uint256 willReceive = newPrincipal - ((newPrincipal * originationFee) / 1e4);

        if (flashAmountDue > willReceive) {
            // Not enough - have borrower pay the difference
            needFromBorrower = flashAmountDue - willReceive;
        } else if (willReceive > flashAmountDue) {
            // Too much - will send extra to borrower
            leftoverPrincipal = willReceive - flashAmountDue;
        }

        // Either leftoverPrincipal or needFromBorrower should be 0
        require(leftoverPrincipal == 0 || needFromBorrower == 0, "funds conflict");
    }

    /**
     * @notice Helper function to repay the loan. Takes the borrowerNote from the borrower, approves
     *         the V2 repayment controller to spend the payable currency recieved from flash loan.
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
        // take BorrowerNote from borrower so that this contract recieves collateral
        // borrower must approve this withdrawal
        borrowerNoteV2.transferFrom(borrower, address(this), borrowerNoteId);

        // approve repayment
        IERC20(loanData.terms.payableCurrency).approve(
            address(repaymentControllerV2),
            loanData.terms.principal + loanData.terms.principal * loanData.terms.interestRate / 1 ether
        );

        // repay loan
        repaymentControllerV2.repay(borrowerNoteId);

        // contract now has collateral but has lost funds
        require(
            IERC721(loanData.terms.collateralAddress).ownerOf(loanData.terms.collateralId) == address(this),
            "collateral ownership"
        );
    }

    /**
     * @notice Helper function to initialize the new loan. Withdraws the collateral from the borrower,
     *         approves the origination controller to spend the collateral, and starts the new loan.
     *         Once the new loan is started, the borrowerNote is sent to the borrower.
     *
     * @param borrower                 The address of the borrower.
     * @param lender                   The address of the new lender.
     * @param opData                   The data used to execute new V3 loan.
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
     * @notice Validates that the rollover is valid. The borrower from the old loan must be the caller.
     *         The new loan must have the same currency as the old loan. The new loan must use the same
     *         vault factory contract as collateral. If any of these conditionals are not met, the
     *         transaction will revert.
     *
     * @param sourceLoanTerms         The terms of the old loan.
     * @param newLoanTerms            The terms of the new loan.
     * @param borrowerNoteId          The ID of the borrowerNote for the old loan.
     */
    function _validateRollover(
        LoanLibraryV2.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        uint256 borrowerNoteId
    ) internal {
        require(borrowerNoteV2.ownerOf(borrowerNoteId) == msg.sender, "caller not borrower");
        require(newLoanTerms.payableCurrency == sourceLoanTerms.payableCurrency, "currency mismatch");
        require(newLoanTerms.collateralAddress == sourceLoanTerms.collateralAddress, "collateral mismatch");
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
        require(balance > 0, "no balance");

        token.transfer(to, balance);
    }

    receive() external payable {}
}