// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./InterestCalculator.sol";
import "./interfaces/ICallDelegator.sol";
import "./interfaces/IPromissoryNote.sol";
import "./interfaces/IAssetVault.sol";
import "./interfaces/IFeeController.sol";
import "./interfaces/ILoanCore.sol";

import "./PromissoryNote.sol";
import "./vault/OwnableERC721.sol";
import {
    LC_ZeroAddress,
    LC_ReusedNote,
    LC_CollateralInUse,
    LC_InvalidState,
    LC_NotExpired,
    LC_NonceUsed
} from "./errors/Lending.sol";

/**
 * @title LoanCore
 * @author Non-Fungible Technologies, Inc.
 *
 * The LoanCore lending contract is the heart of the Arcade.xyz lending protocol.
 * It stores and maintains loan state, enforces loan lifecycle invariants, takes
 * escrow of assets during an active loans, governs the release of collateral on
 * repayment or default, and tracks signature nonces for loan consent.
 *
 * Also contains logic for approving Asset Vault calls using the
 * ICallDelegator interface.
 */
contract LoanCore is
    ILoanCore,
    InterestCalculator,
    AccessControlEnumerable,
    Pausable,
    ReentrancyGuard,
    ICallDelegator
{
    using Counters for Counters.Counter;
    using SafeERC20 for IERC20;

    // ============================================ STATE ==============================================

    // =================== Constants =====================

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ORIGINATOR_ROLE = keccak256("ORIGINATOR_ROLE");
    bytes32 public constant REPAYER_ROLE = keccak256("REPAYER_ROLE");
    bytes32 public constant FEE_CLAIMER_ROLE = keccak256("FEE_CLAIMER_ROLE");

    uint256 private constant PERCENT_MISSED_FOR_LENDER_CLAIM = 4000;

    // =============== Contract References ================

    IPromissoryNote public override borrowerNote;
    IPromissoryNote public override lenderNote;
    IFeeController public override feeController;

    // =================== Loan State =====================

    Counters.Counter private loanIdTracker;
    mapping(uint256 => LoanLibrary.LoanData) private loans;
    // key is hash of (collateralAddress, collateralId)
    mapping(bytes32 => bool) private collateralInUse;
    mapping(address => mapping(uint160 => bool)) public usedNonces;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Deploys the loan core contract, by setting up roles and external
     *         contract references.
     *
     * @param _feeController      The address of the contract governing protocol fees.
     * @param _borrowerNote       The address of the PromissoryNote contract representing borrower obligation.
     * @param _lenderNote         The address of the PromissoryNote contract representing lender obligation.
     */
    constructor(
        IFeeController _feeController,
        IPromissoryNote _borrowerNote,
        IPromissoryNote _lenderNote
    ) AccessControl() Pausable() {
        if (address(_feeController) == address(0)) revert LC_ZeroAddress();
        if (address(_borrowerNote) == address(0)) revert LC_ZeroAddress();
        if (address(_lenderNote) == address(0)) revert LC_ZeroAddress();
        if (address(_borrowerNote) == address(_lenderNote)) revert LC_ReusedNote();

        _setupRole(ADMIN_ROLE, msg.sender);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(ORIGINATOR_ROLE, ADMIN_ROLE);
        _setRoleAdmin(REPAYER_ROLE, ADMIN_ROLE);

        // only those with FEE_CLAIMER_ROLE can update or grant FEE_CLAIMER_ROLE
        _setupRole(FEE_CLAIMER_ROLE, msg.sender);
        _setRoleAdmin(FEE_CLAIMER_ROLE, FEE_CLAIMER_ROLE);

        feeController = _feeController;

        /// @dev Although using references for both promissory notes, these
        ///      must be fresh versions and cannot be re-used across multiple
        ///      loanCore instances, to ensure loanId <> tokenID parity
        borrowerNote = _borrowerNote;
        lenderNote = _lenderNote;

        // Avoid having loanId = 0
        loanIdTracker.increment();
    }

    // ====================================== LIFECYCLE OPERATIONS ======================================

    /**
     * @notice Start a loan, matching a set of terms, with a given
     *         lender and borrower. Collects collateral and distributes
     *         principal, along with collecting an origination fee for the
     *         protocol. Can only be called by OriginationController.
     *
     * @param lender                The lender for the loan.
     * @param borrower              The borrower for the loan.
     * @param terms                 The terms of the loan.
     *
     * @return loanId               The ID of the newly created loan.
     */
    function startLoan(
        address lender,
        address borrower,
        LoanLibrary.LoanTerms calldata terms
    ) external override whenNotPaused onlyRole(ORIGINATOR_ROLE) nonReentrant returns (uint256 loanId) {
        // check collateral is not already used in a loan.
        bytes32 collateralKey = keccak256(abi.encode(terms.collateralAddress, terms.collateralId));
        if (collateralInUse[collateralKey]) revert LC_CollateralInUse(terms.collateralAddress, terms.collateralId);

        // get current loanId and increment for next function call
        loanId = loanIdTracker.current();
        loanIdTracker.increment();

        // Initiate loan state
        loans[loanId] = LoanLibrary.LoanData({
            terms: terms,
            state: LoanLibrary.LoanState.Active,
            startDate: uint160(block.timestamp)
        });

        collateralInUse[collateralKey] = true;

        // Distribute notes and principal
        _mintLoanNotes(loanId, borrower, lender);

        IERC721(terms.collateralAddress).transferFrom(msg.sender, address(this), terms.collateralId);

        IERC20(terms.payableCurrency).safeTransferFrom(msg.sender, address(this), terms.principal);

        IERC20(terms.payableCurrency).safeTransfer(borrower, _getPrincipalLessFees(terms.principal));

        emit LoanStarted(loanId, lender, borrower);
    }

    /**
     * @notice Repay the given loan. Can only be called by RepaymentController,
     *         which verifies repayment conditions. This method will calculate
     *         the total interest due, collect it from the borrower, and redistribute
     *         principal + interest to the lender, and collateral to the borrower.
     *         All promissory notes will be burned and the loan will be marked as complete.
     *
     * @param loanId                The ID of the loan to repay.
     */
    function repay(uint256 loanId) external override onlyRole(REPAYER_ROLE) nonReentrant {
        LoanLibrary.LoanData memory data = loans[loanId];
        // ensure valid initial loan state when starting loan
        if (data.state != LoanLibrary.LoanState.Active) revert LC_InvalidState(data.state);

        uint256 returnAmount = getFullInterestAmount(data.terms.principal, data.terms.interestRate);

        // get promissory notes from two parties involved
        address lender = lenderNote.ownerOf(loanId);
        address borrower = borrowerNote.ownerOf(loanId);

        // state changes and cleanup
        // NOTE: these must be performed before assets are released to prevent reentrance
        loans[loanId].state = LoanLibrary.LoanState.Repaid;
        collateralInUse[keccak256(abi.encode(data.terms.collateralAddress, data.terms.collateralId))] = false;

        _burnLoanNotes(loanId);

        // transfer from msg.sender to this contract
        IERC20(data.terms.payableCurrency).safeTransferFrom(msg.sender, address(this), returnAmount);
        // asset and collateral redistribution
        // Not using safeTransfer to prevent lenders from blocking
        // loan receipt and forcing a default
        IERC20(data.terms.payableCurrency).transfer(lender, returnAmount);
        IERC721(data.terms.collateralAddress).transferFrom(address(this), borrower, data.terms.collateralId);

        emit LoanRepaid(loanId);
    }

    /**
     * @notice Claim collateral on a given loan. Can only be called by RepaymentController,
     *         which verifies claim conditions. This method validates that the loan's due
     *         date has passed, and then distributes collateral to the lender. All promissory
     *         notes will be burned and the loan will be marked as complete.
     *
     * @param loanId                              The ID of the loan to claim.
     */
    function claim(uint256 loanId)
        external
        override
        whenNotPaused
        onlyRole(REPAYER_ROLE)
        nonReentrant
    {
        LoanLibrary.LoanData memory data = loans[loanId];
        // ensure valid initial loan state when starting loan
        if (data.state != LoanLibrary.LoanState.Active) revert LC_InvalidState(data.state);

        // First check if the call is being made after the due date.
        uint256 dueDate = data.startDate + data.terms.durationSecs;
        if (dueDate > block.timestamp) revert LC_NotExpired(dueDate);

        address lender = lenderNote.ownerOf(loanId);

        // NOTE: these must be performed before assets are released to prevent reentrance
        loans[loanId].state = LoanLibrary.LoanState.Defaulted;
        collateralInUse[keccak256(abi.encode(data.terms.collateralAddress, data.terms.collateralId))] = false;

        _burnLoanNotes(loanId);

        // collateral redistribution
        IERC721(data.terms.collateralAddress).transferFrom(address(this), lender, data.terms.collateralId);

        emit LoanClaimed(loanId);
    }

    /**
     * @notice Roll over a loan, atomically closing one and re-opening a new one with the
     *         same collateral. Instead of full repayment, only net payments from each
     *         party are required. Each rolled-over loan is marked as complete, and the new
     *         loan is given a new unique ID and notes. At the time of calling, any needed
     *         net payments have been collected by the RepaymentController for withdrawal.
     *
     * @param oldLoanId             The ID of the old loan.
     * @param borrower              The borrower for the loan.
     * @param lender                The lender for the old loan.
     * @param terms                 The terms of the new loan.
     * @param _settledAmount        The amount LoanCore needs to withdraw to settle.
     * @param _amountToOldLender    The payment to the old lender (if lenders are changing).
     * @param _amountToLender       The payment to the lender (if same as old lender).
     * @param _amountToBorrower     The payemnt to the borrower (in the case of leftover principal).
     *
     * @return newLoanId            The ID of the new loan.
     */
    function rollover(
        uint256 oldLoanId,
        address borrower,
        address lender,
        LoanLibrary.LoanTerms calldata terms,
        uint256 _settledAmount,
        uint256 _amountToOldLender,
        uint256 _amountToLender,
        uint256 _amountToBorrower
    ) external override whenNotPaused onlyRole(ORIGINATOR_ROLE) nonReentrant returns (uint256 newLoanId) {
        // Repay loan
        LoanLibrary.LoanData storage data = loans[oldLoanId];
        data.state = LoanLibrary.LoanState.Repaid;

        address oldLender = lenderNote.ownerOf(oldLoanId);
        IERC20 payableCurrency = IERC20(data.terms.payableCurrency);

        _burnLoanNotes(oldLoanId);

        // Set up new loan
        newLoanId = loanIdTracker.current();
        loanIdTracker.increment();

        loans[newLoanId] = LoanLibrary.LoanData({
            terms: terms,
            state: LoanLibrary.LoanState.Active,
            startDate: uint160(block.timestamp)
        });

        // Distribute notes and principal
        _mintLoanNotes(newLoanId, borrower, lender);

        IERC20(payableCurrency).safeTransferFrom(msg.sender, address(this), _settledAmount);
        _transferIfNonzero(payableCurrency, oldLender, _amountToOldLender);
        _transferIfNonzero(payableCurrency, lender, _amountToLender);
        _transferIfNonzero(payableCurrency, borrower, _amountToBorrower);

        emit LoanRepaid(oldLoanId);
        emit LoanStarted(newLoanId, lender, borrower);
        emit LoanRolledOver(oldLoanId, newLoanId);
    }

    // ======================================== NONCE MANAGEMENT ========================================

    /**
     * @notice Mark a nonce as used in the context of starting a loan. Reverts if
     *         nonce has already been used. Can only be called by Origination Controller.
     *
     * @param user                  The user for whom to consume a nonce.
     * @param nonce                 The nonce to consume.
     */
    function consumeNonce(address user, uint160 nonce) external override whenNotPaused onlyRole(ORIGINATOR_ROLE) {
        _useNonce(user, nonce);
    }

    /**
     * @notice Mark a nonce as used in order to invalidate signatures with the nonce.
     *         Does not allow specifying the user, and automatically consumes the nonce
     *         of the caller.
     *
     * @param nonce                 The nonce to consume.
     */
    function cancelNonce(uint160 nonce) external override {
        _useNonce(msg.sender, nonce);
    }

    // ========================================= VIEW FUNCTIONS =========================================

    /**
     * @notice Returns the LoanData struct for the specified loan ID.
     *
     * @param loanId                The ID of the given loan.
     *
     * @return loanData             The struct containing loan state and terms.
     */
    function getLoan(uint256 loanId) external view override returns (LoanLibrary.LoanData memory loanData) {
        return loans[loanId];
    }

    /**
     * @notice Reports if the caller is allowed to call functions on the given vault.
     *         Determined by if they are the borrower for the loan, defined by ownership
     *         of the relevant BorrowerNote.
     *
     * @dev Implemented as part of the ICallDelegator interface.
     *
     * @param caller                The user that wants to call a function.
     * @param vault                 The vault that the caller wants to call a function on.
     *
     * @return allowed              True if the caller is allowed to call on the vault.
     */
    function canCallOn(address caller, address vault) external view override whenNotPaused returns (bool) {
        // if the collateral is not currently being used in a loan, disallow
        if (!collateralInUse[keccak256(abi.encode(OwnableERC721(vault).ownershipToken(), uint256(uint160(vault))))]) {
            return false;
        }
        for (uint256 i = 0; i < borrowerNote.balanceOf(caller); i++) {
            uint256 loanId = borrowerNote.tokenOfOwnerByIndex(caller, i);

            // if the borrower is currently borrowing against this vault,
            // return true
            if (
                loans[loanId].terms.collateralAddress == OwnableERC721(vault).ownershipToken() &&
                loans[loanId].terms.collateralId == uint256(uint160(vault))
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Reports whether the given nonce has been previously used by a user. Returning
     *         false does not mean that the nonce will not clash with another potential off-chain
     *         signature that is stored somewhere.
     *
     * @param user                  The user to check the nonce for.
     * @param nonce                 The nonce to check.
     *
     * @return used                 Whether the nonce has been used.
     */
    function isNonceUsed(address user, uint160 nonce) external view override returns (bool) {
        return usedNonces[user][nonce];
    }

    // ======================================== ADMIN FUNCTIONS =========================================

    /**
     * @notice Sets the fee controller to a new address. It must implement the
     *         IFeeController interface. Can only be called by the contract owner.
     *
     * @param _newController        The new fee controller contract.
     */
    function setFeeController(IFeeController _newController) external onlyRole(FEE_CLAIMER_ROLE) {
        if (address(_newController) == address(0)) revert LC_ZeroAddress();

        feeController = _newController;

        emit SetFeeController(address(feeController));
    }

    /**
     * @notice Claim the protocol fees for the given token. Any token used as principal
     *         for a loan will have accumulated fees. Must be called by contract owner.
     *
     * @param token                 The contract address of the token to claim fees for.
     */
    function claimFees(IERC20 token) external onlyRole(FEE_CLAIMER_ROLE) {
        // any token balances remaining on this contract are fees owned by the protocol
        uint256 amount = token.balanceOf(address(this));
        token.safeTransfer(msg.sender, amount);
        emit FeesClaimed(address(token), msg.sender, amount);
    }

    /**
     * @notice Pauses the contract, preventing loan lifecyle operations.
     *         Should only be used in case of emergency. Can only be called
     *         by contract owner.
     */
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses the contract, enabling loan lifecycle operations.
     *         Can be used after pausing due to emergency.
     *         Can only be called by contract owner.
     */
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ============================================= HELPERS ============================================

    /**
     * @dev Takes a principal value and returns the amount that will be distributed
     *      to the borrower after protocol fees.
     *
     * @param principal             The principal amount.
     *
     * @return principalLessFees    The amount after fees.
     */
    function _getPrincipalLessFees(uint256 principal) internal view returns (uint256) {
        return principal - (principal * feeController.getOriginationFee()) / BASIS_POINTS_DENOMINATOR;
    }

    /**
     * @dev Consume a nonce, by marking it as used for that user. Reverts if the nonce
     *      has already been used.
     *
     * @param user                  The user for whom to consume a nonce.
     * @param nonce                 The nonce to consume.
     */
    function _useNonce(address user, uint160 nonce) internal {
        if (usedNonces[user][nonce]) revert LC_NonceUsed(user, nonce);
        // set nonce to used
        usedNonces[user][nonce] = true;

        emit NonceUsed(user, nonce);
    }

    /*
     * @dev Mint a borrower and lender note together - easier to make sure
     *      they are synchronized.
     *
     * @param loanId                The token ID to mint.
     * @param borrower              The address of the recipient of the borrower note.
     * @param lender                The address of the recpient of the lender note.
     */
    function _mintLoanNotes(
        uint256 loanId,
        address borrower,
        address lender
    ) internal {
        borrowerNote.mint(borrower, loanId);
        lenderNote.mint(lender, loanId);
    }

    /**
     * @dev Burn a borrower and lender note together - easier to make sure
     *      they are synchronized.
     *
     * @param loanId                The token ID to burn.
     */
    function _burnLoanNotes(uint256 loanId) internal {
        lenderNote.burn(loanId);
        borrowerNote.burn(loanId);
    }

    /**
     * @dev Perform an ERC20 transfer, if the specified amount is nonzero - else no-op.
     *
     * @param token                 The token to transfer.
     * @param to                    The address receiving the tokens.
     * @param amount                The amount of tokens to transfer.
     */
    function _transferIfNonzero(
        IERC20 token,
        address to,
        uint256 amount
    ) internal {
        if (amount > 0) token.safeTransfer(to, amount);
    }
}
