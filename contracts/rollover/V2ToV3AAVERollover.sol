// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../external/interfaces/ILendingPool.sol";
import "../interfaces/IV2ToV3AAVERollover.sol";
import "../interfaces/IRepaymentController.sol";

/**
 * @title V2ToV3AAVERollover
 * @author Non-Fungible Technologies, Inc.
 *
 * It is required that the V2 protocol has zero fees enabled. This contract only works with
 * ERC721 collateral.
 */
contract V2ToV3AAVERollover is IV2ToV3AAVERollover, ReentrancyGuard, ERC721Holder, Ownable {
    using SafeERC20 for IERC20;
    
    // AAVE Contracts
    // Variable names are in upper case to fulfill IFlashLoanReceiver interface
    // Mainnet AAVE AddressProvider- 0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5
    /* solhint-disable var-name-mixedcase */
    ILendingPoolAddressesProvider public immutable override ADDRESSES_PROVIDER;
    ILendingPool public immutable override LENDING_POOL;

    constructor(ILendingPoolAddressesProvider _addressesProvider) {
        ADDRESSES_PROVIDER = _addressesProvider;
        LENDING_POOL = ILendingPool(_addressesProvider.getLendingPool());
    }

    /**
     * @notice Rollover a loan from V2 to V3. Validates new loan terms against the old terms.
     *         Takes out Flash Loan for principal + interest, repays old loan, and starts new 
     *         loan on V3.
     *
     * @param contracts              The contract references needed to rollover the loan.
     * @param loanId                 The ID of the loan to be rolled over.
     * @param newLoanTerms           The terms of the new loan.
     * @param lender                 The address of the lender.
     * @param nonce                  The nonce of the new loan.
     * @param v                      The v value of signature for new loan.
     * @param r                      The r value of signature for new loan.
     * @param s                      The s value of signature for new loan.
     */
    function rolloverLoan(
        RolloverContractParams calldata contracts,
        uint256 loanId,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        address lender,
        uint160 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external override {
        LoanLibraryV2.LoanTerms memory loanTerms = contracts.sourceLoanCore.getLoan(loanId).terms;

        {
            _validateRollover(
                contracts.sourceLoanCore,
                contracts.collateral,
                loanTerms,
                newLoanTerms,
                loanId // same as borrowerNoteId
            );
        }

        {
            address[] memory assets = new address[](1);
            assets[0] = loanTerms.payableCurrency;

            uint256[] memory amounts = new uint256[](1);
            amounts[0] = loanTerms.principal + (loanTerms.principal * loanTerms.interestRate / 1 ether / 1e4);

            uint256[] memory modes = new uint256[](1);
            modes[0] = 0;

            bytes memory params = abi.encode(
                OperationData(
                    {
                        contracts: contracts,
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
            LENDING_POOL.flashLoan(address(this), assets, amounts, modes, address(this), params, 0);
        }
    }

    /**
     * @notice Callback function for flash loan. Calls _executeOperation to rollover loan from V2 to V3.
     *         The caller of this function must be the lending pool.
     *
     * @param assets                 The ERC20 address that was borrowed in Flash Loan.
     * @param amounts                The amount that was borrowed in Flash Loan.
     * @param premiums               The fees that are due to the lending pool.
     * @param params                 The data to be executed after receiving Flash Loan.
     *
     * @return bool                  Returns true if all operations were successful. 
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override nonReentrant returns (bool) {
        require(msg.sender == address(LENDING_POOL), "unknown callback sender");
        require(initiator == address(this), "not initiator");

        return _executeOperation(assets, amounts, premiums, abi.decode(params, (OperationData)));
    }

    /**
     * @notice Executes repayment of old loan and initialization of new loan. Any funds
     *         that are not covered by closing out the old loan must be covered by the borrower.
     *
     * @param assets                 The ERC20 address that was borrowed in Flash Loan.
     * @param amounts                The amount that was borrowed in Flash Loan.
     * @param premiums               The fees that are due back to the lending pool.
     * @param opData                 The data to be executed after receiving Flash Loan.
     *
     * @return bool                  Returns true if all operations were successful.                    
     */
    function _executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] memory premiums,
        OperationData memory opData
    ) internal returns (bool) {
        OperationContracts memory opContracts = _getContracts(opData.contracts);

        // Get loan details
        LoanLibraryV2.LoanData memory loanData = opContracts.loanCore.getLoan(opData.loanId);

        address borrower = opContracts.borrowerNote.ownerOf(opData.loanId);
        address lender = opContracts.lenderNote.ownerOf(opData.loanId);

        // Do accounting to figure out amount each party needs to receive
        (uint256 flashAmountDue, uint256 needFromBorrower, uint256 leftoverPrincipal) = _ensureFunds(
            amounts[0], // principal + interest
            premiums[0], // flash loan fee
            uint256(
                opContracts.feeController.getLendingFee(
                    // FL_01 - borrower origination fee
                    0xdef20ef7dab5e9af36ad3807764d39a61642c6cf31d02729a44c376041189449
                )
            ),
            opData.newLoanTerms.principal // new loan terms principal
        );

        IERC20 asset = IERC20(assets[0]);

        if (needFromBorrower > 0) {
            require(asset.balanceOf(borrower) >= needFromBorrower, "borrower cannot pay");
            require(asset.allowance(borrower, address(this)) >= needFromBorrower, "lacks borrower approval");
        }

        _repayLoan(opContracts, loanData, opData.loanId, borrower);

        {            
            uint256 newLoanId = _initializeNewLoan(
                opContracts,
                borrower,
                opData.lender,
                opData
            );

            emit Rollover(
                lender,
                borrower,
                loanData.terms.collateralId,
                newLoanId
            );

            if (address(opData.contracts.sourceLoanCore) != address(opData.contracts.targetLoanCore)) {
                emit Migration(address(opContracts.loanCore), address(opContracts.targetLoanCore), newLoanId);
            }
        }

        if (leftoverPrincipal > 0) {
            asset.safeTransfer(borrower, leftoverPrincipal);
        } else if (needFromBorrower > 0) {
            asset.safeTransferFrom(borrower, address(this), needFromBorrower);
        }

        // Approve all amounts for flash loan repayment
        asset.approve(address(LENDING_POOL), flashAmountDue);

        return true;
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
     * @param contracts                Contract references needed to repay the loan.
     * @param loanData                 The loan data for the loan to be repaid.
     * @param borrowerNoteId           ID of the borrowerNote for the loan to be repaid.
     * @param borrower                 The address of the borrower.
     */
    function _repayLoan(
        OperationContracts memory contracts,
        LoanLibraryV2.LoanData memory loanData,
        uint256 borrowerNoteId,
        address borrower
    ) internal {
        // take BorrowerNote from borrower so that this contract recieves collateral
        // borrower must approve this withdrawal
        contracts.borrowerNote.transferFrom(borrower, address(this), borrowerNoteId);

        // approve repayment
        IERC20(loanData.terms.payableCurrency).approve(
            address(contracts.repaymentController),
            loanData.terms.principal + loanData.terms.principal * loanData.terms.interestRate / 1 ether
        );

        // repay loan
        contracts.repaymentController.repay(borrowerNoteId);

        // contract now has collateral but has lost funds
        require(
            IERC721(address(contracts.collateral)).ownerOf(loanData.terms.collateralId) == address(this),
            "collateral ownership"
        );
    }

    /**
     * @notice Helper function to initialize the new loan. Withdraws the collateral from the borrower,
     *         approves the origination controller to spend the collateral, and starts the new loan.
     *         Once the new loan is started, the borrowerNote is sent to the borrower.
     *
     * @param contracts                Contract references needed to rollover the loan.
     * @param borrower                 The address of the borrower.
     * @param lender                   The address of the new lender.
     * @param opData                   The data used to execute new V3 loan.
     *
     * @return newLoanId               V3 loanId for the new loan that is started.
     */
    function _initializeNewLoan(
        OperationContracts memory contracts,
        address borrower,
        address lender,
        OperationData memory opData
    ) internal returns (uint256) {
        uint256 collateralId = opData.newLoanTerms.collateralId;

        // approve targetLoanCore to take collateral
        IERC721(address(contracts.collateral)).approve(address(contracts.targetLoanCore), collateralId);

        // start new loan
        // stand in for borrower to meet OriginationController's requirements
        uint256 newLoanId = contracts.originationController.initializeLoan(
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
        contracts.targetBorrowerNote.safeTransferFrom(address(this), borrower, newLoanId);

        return newLoanId;
    }

    /**
     * @notice Helper function to get all contracts needed for rollover operations.
     *
     * @param contracts                Contract references needed to rollover the loan.
     *
     * @return OperationContracts      All contracts needed for rollover operations.
     */
    function _getContracts(RolloverContractParams memory contracts) internal returns (OperationContracts memory) {
        return
            OperationContracts({
                loanCore: contracts.sourceLoanCore,
                borrowerNote: contracts.sourceLoanCore.borrowerNote(),
                lenderNote: contracts.sourceLoanCore.lenderNote(),
                feeController: contracts.targetOriginationController.feeController(),
                collateral: contracts.collateral,
                repaymentController: contracts.sourceRepaymentController,
                originationController: contracts.targetOriginationController,
                targetLoanCore: contracts.targetLoanCore,
                targetBorrowerNote: contracts.targetLoanCore.borrowerNote()
            });
    }

    /**
     * @notice Validates that the rollover is valid. The borrower from the old loan must be the caller.
     *         The new loan must have the same currency as the old loan. The new loan must use the same
     *         vault factory contract as collateral. If any of these conditionals are not met, the
     *         transaction will revert.
     *
     * @param sourceLoanCore          The LoanCore contract for the old loan.
     * @param collateral              The collateral contract used by both loans.
     * @param sourceLoanTerms         The terms of the old loan.
     * @param newLoanTerms            The terms of the new loan.
     * @param borrowerNoteId          The ID of the borrowerNote for the old loan.
     */
    function _validateRollover(
        ILoanCoreV2 sourceLoanCore,
        IERC721 collateral,
        LoanLibraryV2.LoanTerms memory sourceLoanTerms,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        uint256 borrowerNoteId
    ) internal {
        require(sourceLoanCore.borrowerNote().ownerOf(borrowerNoteId) == msg.sender, "caller not borrower");
        require(newLoanTerms.payableCurrency == sourceLoanTerms.payableCurrency, "currency mismatch");
        require(newLoanTerms.collateralAddress == address(collateral), "new terms collateral mismatch");
        require(sourceLoanTerms.collateralAddress == address(collateral), "old terms collateralAddress mismatch");
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