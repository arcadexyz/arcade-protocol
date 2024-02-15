// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Counters.sol";

import "./interfaces/ILoanCore.sol";
import "./interfaces/ICallDelegator.sol";
import "./interfaces/IPromissoryNote.sol";

import "./PromissoryNote.sol";
import "./libraries/InterestCalculator.sol";
import "./libraries/Constants.sol";
import "./vault/OwnableERC721.sol";
import {
    LC_ZeroAddress,
    LC_ReusedNote,
    LC_CannotSettle,
    LC_CannotWithdraw,
    LC_ZeroAmount,
    LC_ArrayLengthMismatch,
    LC_OverMaxSplit,
    LC_CollateralInUse,
    LC_InvalidState,
    LC_NotExpired,
    LC_NonceUsed,
    LC_MaxNonceUses,
    LC_AffiliateCodeAlreadySet,
    LC_CallerNotLoanCore,
    LC_NoReceipt,
    LC_Shutdown,
    LC_ExceedsBalance
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

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN");
    bytes32 public constant ORIGINATOR_ROLE = keccak256("ORIGINATOR");
    bytes32 public constant REPAYER_ROLE = keccak256("REPAYER");
    bytes32 public constant AFFILIATE_MANAGER_ROLE = keccak256("AFFILIATE_MANAGER");
    bytes32 public constant FEE_CLAIMER_ROLE = keccak256("FEE_CLAIMER");
    bytes32 public constant SHUTDOWN_ROLE = keccak256("SHUTDOWN");

    // =============== Contract References ================

    IPromissoryNote public immutable override borrowerNote;
    IPromissoryNote public immutable override lenderNote;

    // =================== Loan State =====================

    /// @dev Counter for serial IDs of all loans created.
    Counters.Counter private loanIdTracker;

    /// @dev Lookup table storing loan data structure.
    mapping(uint256 => LoanLibrary.LoanData) private loans;

    /// @dev Lookup table showing what collateral is currently being escrowed.
    ///      Key is hash of (collateralAddress, collateralId).
    mapping(bytes32 => bool) private collateralInUse;

    /// @dev Lookup table showing for which user, which nonces have been used.
    ///      user => nonce => isUsed
    mapping(address => mapping(uint160 => bool)) public usedNonces;

    /// @dev Lookup table showing for a given user and nonce, how many times the nonce has been used.
    ///      user => nonce => numberOfUses
    mapping(address => mapping(uint160 => uint96)) public numNonceUses;

    // =================== Fee Management =====================

    /// @dev affiliate code => affiliate split
    ///      split contains payout address and a feeShare in bps
    mapping(bytes32 => AffiliateSplit) public affiliateSplits;

    /// @dev token => user => amount fees
    mapping(address => mapping(address => uint256)) public feesWithdrawable;

    /// @dev tokenId => {token, amount}
    ///      can be withdrawn by burning LenderNote of matching tokenId
    mapping(uint256 => NoteReceipt) public noteReceipts;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Deploys the loan core contract, by setting up roles and external
     *         contract references.
     *
     * @param _borrowerNote       The address of the PromissoryNote contract representing borrower obligation.
     * @param _lenderNote         The address of the PromissoryNote contract representing lender obligation.
     */
    constructor(IPromissoryNote _borrowerNote, IPromissoryNote _lenderNote) {
        if (address(_borrowerNote) == address(0)) revert LC_ZeroAddress("borrowerNote");
        if (address(_lenderNote) == address(0)) revert LC_ZeroAddress("lenderNote");
        if (address(_borrowerNote) == address(_lenderNote)) revert LC_ReusedNote();

        _setupRole(ADMIN_ROLE, msg.sender);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(ORIGINATOR_ROLE, ADMIN_ROLE);
        _setRoleAdmin(REPAYER_ROLE, ADMIN_ROLE);
        _setRoleAdmin(FEE_CLAIMER_ROLE, ADMIN_ROLE);
        _setRoleAdmin(AFFILIATE_MANAGER_ROLE, ADMIN_ROLE);
        _setRoleAdmin(SHUTDOWN_ROLE, ADMIN_ROLE);

        /// @dev Although using references for both promissory notes, these
        ///      must be fresh versions and cannot be re-used across multiple
        ///      loanCore instances, to ensure loanId <> tokenID parity. This is
        ///      enforced via deployment processes.
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
     *         protocol and/or affiliate. Can only be called by OriginationController.
     *
     * @param lender                The lender for the loan.
     * @param borrower              The borrower for the loan.
     * @param terms                 The terms of the loan.
     * @param _amountFromLender     The amount of principal to be collected from the lender.
     * @param _amountToBorrower     The amount of principal to be distributed to the borrower (net after fees).
     *
     * @return loanId               The ID of the newly created loan.
     */
    function startLoan(
        address lender,
        address borrower,
        LoanLibrary.LoanTerms calldata terms,
        uint256 _amountFromLender,
        uint256 _amountToBorrower,
        LoanLibrary.FeeSnapshot calldata _feeSnapshot
    ) external override whenNotPaused onlyRole(ORIGINATOR_ROLE) nonReentrant returns (uint256 loanId) {
        // Check collateral is not already used in a loan
        bytes32 collateralKey = keccak256(abi.encode(terms.collateralAddress, terms.collateralId));
        if (collateralInUse[collateralKey]) revert LC_CollateralInUse(terms.collateralAddress, terms.collateralId);

        // Check that we will not net lose tokens
        if (_amountToBorrower > _amountFromLender) revert LC_CannotSettle(_amountToBorrower, _amountFromLender);

        // Mark collateral as escrowed
        collateralInUse[collateralKey] = true;

        // Assign fees for withdrawal
        uint256 feesEarned;
        unchecked { feesEarned = _amountFromLender - _amountToBorrower; }
        (uint256 protocolFee, uint256 affiliateFee, address affiliate) =
            _getAffiliateSplit(feesEarned, terms.affiliateCode);


        if (protocolFee > 0) feesWithdrawable[terms.payableCurrency][address(this)] += protocolFee;
        if (affiliateFee > 0) feesWithdrawable[terms.payableCurrency][affiliate] += affiliateFee;

        // Get current loanId and increment for next function call
        loanId = loanIdTracker.current();
        loanIdTracker.increment();

        // Initiate loan state
        loans[loanId] = LoanLibrary.LoanData({
            state: LoanLibrary.LoanState.Active,
            startDate: uint64(block.timestamp),
            lastAccrualTimestamp: uint64(block.timestamp),
            terms: terms,
            feeSnapshot: _feeSnapshot,
            balance: terms.principal,
            interestAmountPaid: 0
        });

        // Distribute notes and principal
        _mintLoanNotes(loanId, borrower, lender);

        emit LoanStarted(loanId, lender, borrower);
    }

    /**
     * @notice Repay the given loan. Can only be called by RepaymentController,
     *         which verifies repayment conditions. This method will collect
     *         the total interest due from the borrower  and redistribute
     *         principal + interest to the lender, and collateral to the borrower.
     *         All promissory notes will be burned and the loan will be marked as complete.
     *
     * @param loanId                The ID of the loan to repay.
     * @param payer                 The party repaying the loan.
     * @param _amountToLender       The amount of tokens to be distributed to the lender (net after fees).
     * @param _interestAmount       The interest amount to be paid.
     * @param _paymentToPrincipal   The portion of the repayment amount that goes to principal.
     */
    function repay(
        uint256 loanId,
        address payer,
        uint256 _amountToLender,
        uint256 _interestAmount,
        uint256 _paymentToPrincipal
    ) external override onlyRole(REPAYER_ROLE) nonReentrant {
        (LoanLibrary.LoanData memory data, uint256 amountFromPayer) = _handleRepay(
            loanId,
            _amountToLender,
            _interestAmount,
            _paymentToPrincipal
        );

        // get promissory notes from two parties involved
        address lender = lenderNote.ownerOf(loanId);
        address borrower = borrowerNote.ownerOf(loanId);

        // collect principal and interest from borrower
        _collectIfNonzero(IERC20(data.terms.payableCurrency), payer, amountFromPayer);
        // send repayment less fees to lender
        _transferIfNonzero(IERC20(data.terms.payableCurrency), lender, _amountToLender);

        if (loans[loanId].state == LoanLibrary.LoanState.Repaid) {
            // if loan is completely repaid
            // burn both notes
            _burnLoanNotes(loanId);
            // redistribute collateral and emit event
            IERC721(data.terms.collateralAddress).safeTransferFrom(address(this), borrower, data.terms.collateralId);

            emit LoanRepaid(loanId);
        }

        emit LoanPayment(loanId);
    }

    /**
     * @notice Let the borrower repay the given loan, but do not release principal to the lender:
     *         instead, make it available for withdrawal. Should be used in cases where the borrower wants
     *         to fulfill loan obligations but the lender cannot receive tokens (due to malicious or
     *         accidental behavior, token blacklisting etc).
     *
     * @param loanId                The ID of the loan to repay.
     * @param payer                 The party repaying the loan.
     * @param _amountToLender       The amount of tokens to be distributed to the lender (net after fees).
     * @param _interestAmount       The interest amount to be paid.
     * @param _paymentToPrincipal   The portion of the repayment amount that goes to principal.
     */
    function forceRepay(
        uint256 loanId,
        address payer,
        uint256 _amountToLender,
        uint256 _interestAmount,
        uint256 _paymentToPrincipal
    ) external override onlyRole(REPAYER_ROLE) nonReentrant {
        (LoanLibrary.LoanData memory data, uint256 amountFromPayer) = _handleRepay(
            loanId,
            _amountToLender,
            _interestAmount,
            _paymentToPrincipal
        );

        // DO NOT send collected principal, but make it available for withdrawal by a holder of the LenderNote
        NoteReceipt storage receipt = noteReceipts[loanId];
        if (receipt.token == address(0)) {
            receipt.token = data.terms.payableCurrency;
            receipt.amount = _amountToLender;
        } else {
            receipt.amount += _amountToLender;
        }

        // collect repayment amount from payer
        _collectIfNonzero(IERC20(data.terms.payableCurrency), payer, amountFromPayer);

        if (loans[loanId].state == LoanLibrary.LoanState.Repaid) {
            // if loan is completely repaid
            // burn BorrowerNote, DO NOT burn LenderNote until receipt is redeemed
            address borrower = borrowerNote.ownerOf(loanId);
            borrowerNote.burn(loanId);
            // redistribute collateral and emit event
            IERC721(data.terms.collateralAddress).safeTransferFrom(address(this), borrower, data.terms.collateralId);

            emit LoanRepaid(loanId);
        }

        emit LoanPayment(loanId);
        emit ForceRepay(loanId);
    }

    /**
     * @notice Claim collateral on a given loan. Can only be called by RepaymentController,
     *         which verifies claim conditions. This method validates that the loan's due
     *         date has passed, and the grace period of 10 mins has also passed. Then it distributes
     *         collateral to the lender. All promissory notes will be burned and the loan
     *         will be marked as complete.
     *
     * @dev If LoanCore is holding a withdrawal balance for this loan's NoteReceipt. The collateral
     *      cannot be claimed until the available balance is withdrawn.
     *
     * @param loanId                              The ID of the loan to claim.
     * @param _amountFromLender                   Any claiming fees to be collected from the lender.
     */
    function claim(uint256 loanId, uint256 _amountFromLender)
        external
        override
        onlyRole(REPAYER_ROLE)
        nonReentrant
    {
        LoanLibrary.LoanData memory data = loans[loanId];
        // Ensure valid initial loan state when claiming loan
        if (data.state != LoanLibrary.LoanState.Active) revert LC_InvalidState(data.state);

        // First check if the call is being made after the due date plus 10 min grace period.
        uint256 dueDate = data.startDate + data.terms.durationSecs + Constants.GRACE_PERIOD;
        if (dueDate >= block.timestamp) revert LC_NotExpired(dueDate);

        // State changes and cleanup
        loans[loanId].state = LoanLibrary.LoanState.Defaulted;
        collateralInUse[keccak256(abi.encode(data.terms.collateralAddress, data.terms.collateralId))] = false;

        if (_amountFromLender > 0) {
            // Assign fees for withdrawal
            (uint256 protocolFee, uint256 affiliateFee, address affiliate) =
                _getAffiliateSplit(_amountFromLender, data.terms.affiliateCode);

            mapping(address => uint256) storage _feesWithdrawable = feesWithdrawable[data.terms.payableCurrency];
            if (protocolFee > 0) _feesWithdrawable[address(this)] += protocolFee;
            if (affiliateFee > 0) _feesWithdrawable[affiliate] += affiliateFee;
        }

        // Get owner of the LenderNote
        address lender = lenderNote.ownerOf(loanId);
        // Burn both notes
        _burnLoanNotes(loanId);

        // Collateral redistribution
        IERC721(data.terms.collateralAddress).safeTransferFrom(address(this), lender, data.terms.collateralId);

        // Collect claim fee from lender
        _collectIfNonzero(IERC20(data.terms.payableCurrency), lender, _amountFromLender);

        emit LoanClaimed(loanId);
    }

    /**
     * @notice Burn a lender note, for an already-completed loan, in order to receive
     *         held tokens already paid back by the borrower. Can only be called by the
     *         owner of the note.
     *
     * @param loanId                    The ID of the lender note to redeem.
     * @param _amountFromLender         Any redemption fees to be collected from the lender.
     * @param to                        The address to receive the held tokens.
     */
    function redeemNote(
        uint256 loanId,
        uint256 _amountFromLender,
        address to
    ) external override onlyRole(REPAYER_ROLE) nonReentrant {
        NoteReceipt memory receipt = noteReceipts[loanId];
        (address token, uint256 amount) = (receipt.token, receipt.amount);
        if (token == address(0)) revert LC_NoReceipt(loanId);
        if (amount == 0) revert LC_ZeroAmount();

        // Deduct the redeem fee from the amount and assign for withdrawal
        amount -= _amountFromLender;

        {
            // Assign fees for withdrawal
            (uint256 protocolFee, uint256 affiliateFee, address affiliate) =
                _getAffiliateSplit(_amountFromLender, loans[loanId].terms.affiliateCode);

            mapping(address => uint256) storage _feesWithdrawable = feesWithdrawable[token];
            if (protocolFee > 0) _feesWithdrawable[address(this)] += protocolFee;
            if (affiliateFee > 0) _feesWithdrawable[affiliate] += affiliateFee;
        }

        // Get owner of the LenderNote
        address lender = lenderNote.ownerOf(loanId);

        // if the loan has been completely repaid and no more repayments are expected
        LoanLibrary.LoanState state = loans[loanId].state;
        if (state == LoanLibrary.LoanState.Repaid || state == LoanLibrary.LoanState.Defaulted) {
            // delete the receipt
            delete noteReceipts[loanId];

            // Burn ONLY the LenderNote
            lenderNote.burn(loanId);
        } else {
            // zero out the total amount owed in the receipt
            noteReceipts[loanId].amount = 0;
        }

        // Transfer the held tokens to the lender-specified address
        _transferIfNonzero(IERC20(token), to, amount);

        emit NoteRedeemed(token, lender, to, loanId, amount);
    }

    /**
     * @notice Roll over a loan, atomically closing one and re-opening a new one with the
     *         same collateral. Instead of full repayment, only net payments from each
     *         party are required. Each rolled-over loan is marked as complete, and the new
     *         loan is given a new unique ID and notes. At the time of calling, any needed
     *         net payments have been collected by the RepaymentController for withdrawal.
     *
     * @param oldLoanId             The ID of the old loan.
     * @param oldLender             The lender for the old loan.
     * @param borrower              The borrower for the loan.
     * @param lender                The lender for the old loan.
     * @param terms                 The terms of the new loan.
     * @param _settledAmount        The amount LoanCore needs to withdraw to settle.
     * @param _amountToOldLender    The payment to the old lender (if lenders are changing).
     * @param _amountToLender       The payment to the lender (if same as old lender).
     * @param _amountToBorrower     The payment to the borrower (in the case of leftover principal).
     * @param _interestAmount       The interest amount to be paid.
     *
     * @return newLoanId            The ID of the new loan.
     */
    function rollover(
        uint256 oldLoanId,
        address oldLender,
        address borrower,
        address lender,
        LoanLibrary.LoanTerms calldata terms,
        uint256 _settledAmount,
        uint256 _amountToOldLender,
        uint256 _amountToLender,
        uint256 _amountToBorrower,
        uint256 _interestAmount
    ) external override whenNotPaused onlyRole(ORIGINATOR_ROLE) nonReentrant returns (uint256 newLoanId) {
        LoanLibrary.LoanData storage data = loans[oldLoanId];
        // Ensure valid loan state for old loan
        if (data.state != LoanLibrary.LoanState.Active) revert LC_InvalidState(data.state);

        // State change for old loan
        data.state = LoanLibrary.LoanState.Repaid;
        data.balance = 0;
        data.interestAmountPaid += _interestAmount;

        IERC20 payableCurrency = IERC20(data.terms.payableCurrency);

        // Check that contract will not net lose tokens
        if (_amountToOldLender + _amountToLender + _amountToBorrower > _settledAmount)
            revert LC_CannotSettle(_amountToOldLender + _amountToLender + _amountToBorrower, _settledAmount);
        {
            // Assign fees for withdrawal
            uint256 feesEarned;
            unchecked { feesEarned = _settledAmount - _amountToOldLender - _amountToLender - _amountToBorrower; }

            // Make sure split goes to affiliate code from _new_ terms
            (uint256 protocolFee, uint256 affiliateFee, address affiliate) =
                _getAffiliateSplit(feesEarned, terms.affiliateCode);

            // Assign fees for withdrawal
            mapping(address => uint256) storage _feesWithdrawable = feesWithdrawable[address(payableCurrency)];
            if (protocolFee > 0) _feesWithdrawable[address(this)] += protocolFee;
            if (affiliateFee > 0) _feesWithdrawable[affiliate] += affiliateFee;
        }

        // Set up new loan
        newLoanId = loanIdTracker.current();
        loanIdTracker.increment();

        loans[newLoanId] = LoanLibrary.LoanData({
            state: LoanLibrary.LoanState.Active,
            startDate: uint64(block.timestamp),
            lastAccrualTimestamp: uint64(block.timestamp),
            terms: terms,
            feeSnapshot: data.feeSnapshot,
            balance: terms.principal,
            interestAmountPaid: 0
        });

        // Burn old notes
        _burnLoanNotes(oldLoanId);

        // Mint new notes
        _mintLoanNotes(newLoanId, borrower, lender);

        // Perform net settlement operations
        _collectIfNonzero(payableCurrency, msg.sender, _settledAmount);
        _transferIfNonzero(payableCurrency, oldLender, _amountToOldLender);
        _transferIfNonzero(payableCurrency, lender, _amountToLender);
        _transferIfNonzero(payableCurrency, borrower, _amountToBorrower);

        emit LoanRepaid(oldLoanId);
        emit LoanStarted(newLoanId, lender, borrower);
        emit LoanRolledOver(oldLoanId, newLoanId);
    }

    // ======================================== NONCE MANAGEMENT ========================================

    /**
     * @notice For a given user and nonce, increment the number of times the nonce has been used. If this
     *         this is the last use, set the nonce to used. Reverts if nonce has reach its maximum amount
     *         of uses. Can only be called by Origination Controller.
     *
     * @param user                  The user for whom to consume a nonce.
     * @param nonce                 The nonce to consume.
     * @param maxUses               The maximum number of times the nonce can be used.
     */
    function consumeNonce(
        address user,
        uint160 nonce,
        uint96 maxUses
    ) external override whenNotPaused onlyRole(ORIGINATOR_ROLE) {
        _useNonce(user, nonce, maxUses);
    }

    /**
     * @notice Mark a nonce as used in order to invalidate signatures with the nonce.
     *         Does not allow specifying the user, and automatically consumes the nonce
     *         of the caller.
     *
     * @param nonce                 The nonce to consume.
     */
    function cancelNonce(uint160 nonce) external override {
        mapping(uint160 => bool) storage _usedNonces = usedNonces[msg.sender];

        if (_usedNonces[nonce]) revert LC_NonceUsed(msg.sender, nonce);
        // set nonce to used
        _usedNonces[nonce] = true;

        emit NonceUsed(msg.sender, nonce);
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
     * @notice Returns the note receipt data for a given loan ID. Does
     *         not revert, returns 0 if no receipt.
     *
     * @param loanId                The ID of the given loan.
     *
     * @return token                The address of the token for the note.
     * @return amount               The amount of the note.
     */
    function getNoteReceipt(uint256 loanId) external view override returns (address, uint256) {
        NoteReceipt storage receipt = noteReceipts[loanId];
        return (receipt.token, receipt.amount);
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

        uint256 noteCount = borrowerNote.balanceOf(caller);
        for (uint256 i = 0; i < noteCount;) {
            uint256 loanId = borrowerNote.tokenOfOwnerByIndex(caller, i);
            LoanLibrary.LoanTerms storage terms = loans[loanId].terms;

            // if the borrower is currently borrowing against this vault,
            // return true
            if (
                terms.collateralAddress == OwnableERC721(vault).ownershipToken() &&
                terms.collateralId == uint256(uint160(vault))
            ) {
                return true;
            }

            // Can never overflow bc balanceOf is bounded by uint256
            unchecked {
                i++;
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

    /**
     * @notice Returns the number of times a nonce has been used to start a loan.
     *
     * @param user                  The user to check the nonce for.
     * @param nonce                 The nonce to check.
     *
     * @return numUses              The number of times the nonce has been used.
     */
    function numberOfNonceUses(address user, uint160 nonce) external view override returns (uint96) {
        return numNonceUses[user][nonce];
    }

    /**
     * @notice Returns the effective interest rate for a given loan. If the loan is active,
     *         the interest rate is calculated based on the current timestamp and the prorated
     *         interest due for the loan. If the loan is repaid, the interest rate is calculated
     *         based on the total interest paid over the life of the loan.
     *
     * @param loanId                The ID of the given loan.
     *
     * @return interestRate         The effective interest rate for the loan.
     */
    function getCloseEffectiveInterestRate(uint256 loanId) external view returns (uint256) {
        LoanLibrary.LoanData memory data = loans[loanId];

        if (data.state == LoanLibrary.LoanState.Active) {
            // if loan is active get the effective interest rate if the loan were to be closed now
            return
                InterestCalculator.closeNowEffectiveInterestRate(
                    data.balance,
                    data.terms.principal,
                    data.interestAmountPaid,
                    data.terms.interestRate,
                    uint256(data.terms.durationSecs),
                    uint256(data.startDate),
                    uint256(data.lastAccrualTimestamp),
                    block.timestamp
                );
        } else if (data.state == LoanLibrary.LoanState.Repaid) {
            if (data.lastAccrualTimestamp > data.startDate + data.terms.durationSecs) {
                // If loan is repaid and last interest accrual was after the loan duration,
                // get the effective interest rate based on the loan duration.
                // Interest cannot accrue past the loan duration.
                return
                    InterestCalculator.effectiveInterestRate(
                        data.interestAmountPaid,
                        uint256(data.terms.durationSecs),
                        data.terms.principal
                    );
            }

            // If loan is repaid before loan duration get the effective interest
            // rate based on the total interest paid adn time elapsed.
            return
                InterestCalculator.effectiveInterestRate(
                    data.interestAmountPaid,
                    uint256(data.lastAccrualTimestamp) - uint256(data.startDate),
                    data.terms.principal
                );
        } else {
            revert LC_InvalidState(data.state);
        }
    }

    // ========================================= FEE MANAGEMENT =========================================

    /**
     * @notice Claim any feesWithdrawable balance pending for the caller, as specified by token.
     *         This may accumulate from either affiliate fee shares or borrower forced repayments.
     *
     * @param token                 The contract address of the token to claim tokens for.
     * @param amount                The amount of tokens to claim.
     * @param to                    The address to send the tokens to.
     */
    function withdraw(address token, uint256 amount, address to) external override nonReentrant {
        if (token == address(0)) revert LC_ZeroAddress("token");
        if (amount == 0) revert LC_ZeroAmount();
        if (to == address(0)) revert LC_ZeroAddress("to");

        // any token balances remaining on this contract are fees owned by the protocol
        mapping(address => uint256) storage _feesWithdrawable = feesWithdrawable[token];

        uint256 available = _feesWithdrawable[msg.sender];
        if (amount > available) revert LC_CannotWithdraw(amount, available);

        unchecked { _feesWithdrawable[msg.sender] -= amount; }

        _transferIfNonzero(IERC20(token), to, amount);

        emit FeesWithdrawn(token, msg.sender, to, amount);
    }

    /**
     * @notice Claim the protocol fees for the given token. Any token used as principal
     *         for a loan will have accumulated fees. Must be called by contract owner.
     *
     * @param token                     The contract address of the token to claim fees for.
     * @param to                        The address to send the fees to.
     */
    function withdrawProtocolFees(address token, address to) external override nonReentrant onlyRole(FEE_CLAIMER_ROLE) {
        if (token == address(0)) revert LC_ZeroAddress("token");
        if (to == address(0)) revert LC_ZeroAddress("to");

        // any token balances remaining on this contract are fees owned by the protocol
        mapping(address => uint256) storage _feesWithdrawable = feesWithdrawable[token];
        uint256 amount = _feesWithdrawable[address(this)];
        _feesWithdrawable[address(this)] = 0;

        _transferIfNonzero(IERC20(token), to, amount);

        emit FeesWithdrawn(token, msg.sender, to, amount);
    }

    // ======================================== ADMIN FUNCTIONS =========================================

    /**
     * @notice Set the affiliate fee splits for the batch of affiliate codes. Codes and splits should
     *         be matched index-wise. Can only be called by protocol admin.
     *
     * @param codes                     The affiliate code to set the split for.
     * @param splits                    The splits to set for the given codes.
     */
    function setAffiliateSplits(
        bytes32[] calldata codes,
        AffiliateSplit[] calldata splits
    ) external override onlyRole(AFFILIATE_MANAGER_ROLE) {
        if (codes.length != splits.length) revert LC_ArrayLengthMismatch();

        for (uint256 i = 0; i < codes.length;) {
            if (splits[i].splitBps > Constants.MAX_AFFILIATE_SPLIT)
                revert LC_OverMaxSplit(splits[i].splitBps, Constants.MAX_AFFILIATE_SPLIT);

            if (affiliateSplits[codes[i]].affiliate != address(0))
                revert LC_AffiliateCodeAlreadySet(codes[i]);

            affiliateSplits[codes[i]] = splits[i];
            emit AffiliateSet(codes[i], splits[i].affiliate, splits[i].splitBps);

            // codes is calldata, overflow is impossible bc of calldata
            // size limits vis-a-vis gas
            unchecked {
                i++;
            }
        }
    }

    /**
     * @notice Shuts down the contract, callable by a designated role. Irreversible.
     *         When the contract is shutdown, loans can only be repaid.
     *         New loans cannot be started, defaults cannot be claimed,
     *         loans cannot be rolled over, and vault utility cannot be
     *         employed. This is an emergency recovery feature.
     */
    function shutdown() external onlyRole(SHUTDOWN_ROLE) {
        _pause();
    }

    // ============================================= HELPERS ============================================


    /**
     * @dev Perform shared logic across repay operations repay and forceRepay - all "checks" and "effects".
     *      Will validate loan state, perform accounting calculations, update storage and burn loan notes.
     *      Transfers should occur in the calling function.
     *
     * @param loanId                 The ID of the loan to repay.
     * @param _amountToLender        The amount of tokens to be distributed to the lender (net after fees).
     * @param _interestAmount        The amount of interest to be paid.
     * @param _paymentToPrincipal    The amount of principal to be paid.
     *
     * @return data                  The loan data for the repay operation.
     * @return amountFromPayer       The principal plus interest to be collected from the payer.
     */
    function _handleRepay(
        uint256 loanId,
        uint256 _amountToLender,
        uint256 _interestAmount,
        uint256 _paymentToPrincipal
    ) internal returns (LoanLibrary.LoanData memory data, uint256 amountFromPayer) {
        data = loans[loanId];
        // Ensure valid initial loan state when repaying loan
        if (data.state != LoanLibrary.LoanState.Active) revert LC_InvalidState(data.state);

        amountFromPayer = _paymentToPrincipal + _interestAmount;

        // Check that we will not net lose tokens
        if (_amountToLender > amountFromPayer) revert LC_CannotSettle(_amountToLender, amountFromPayer);
        // Check that the payment to principal is not greater than the balance
        if (_paymentToPrincipal > data.balance) revert LC_ExceedsBalance(_paymentToPrincipal, data.balance);

        uint256 feesEarned;
        unchecked { feesEarned = amountFromPayer - _amountToLender; }

        (uint256 protocolFee, uint256 affiliateFee, address affiliate) =
            _getAffiliateSplit(feesEarned, data.terms.affiliateCode);

        // Assign fees for withdrawal
        mapping(address => uint256) storage _feesWithdrawable = feesWithdrawable[data.terms.payableCurrency];
        if (protocolFee > 0) _feesWithdrawable[address(this)] += protocolFee;
        if (affiliateFee > 0) _feesWithdrawable[affiliate] += affiliateFee;

        // state changes
        if (_paymentToPrincipal == data.balance) {
            // If the payment is equal to the balance, the loan is repaid
            loans[loanId].state = LoanLibrary.LoanState.Repaid;
            // mark collateral as no longer escrowed
            collateralInUse[keccak256(abi.encode(data.terms.collateralAddress, data.terms.collateralId))] = false;
        }

        loans[loanId].interestAmountPaid += _interestAmount;
        loans[loanId].balance -= _paymentToPrincipal;
        loans[loanId].lastAccrualTimestamp = uint64(block.timestamp);
    }

    /**
     * @dev Lookup the submitted affiliateCode for a split value, and return the amount
     *      going to protocol and the amount going to the affiliate, along with destination.
     *
     * @param amount                The amount to split.
     * @param affiliateCode         The affiliate code to lookup.
     *
     * @return protocolFee          The amount going to protocol.
     * @return affiliateFee         The amount going to the affiliate.
     * @return affiliate            The address of the affiliate.
     */
    function _getAffiliateSplit(
        uint256 amount,
        bytes32 affiliateCode
    ) internal view returns (uint256 protocolFee, uint256 affiliateFee, address affiliate) {
        AffiliateSplit memory split = affiliateSplits[affiliateCode];

        if (split.affiliate == address(0)) {
            return (amount, 0, address(0));
        }

        affiliate = split.affiliate;
        affiliateFee = amount * split.splitBps / Constants.BASIS_POINTS_DENOMINATOR;
        unchecked { protocolFee = amount - affiliateFee; }
    }

    /**
     * @dev Determine if a nonce has been used, and if not, increment the number of times
     *      the nonce has been used. If the nonce has reached the maximum number of uses,
     *      mark the nonce as used. Revert if the nonce has already been used.
     *
     * @param user                  The user for whom to consume a nonce.
     * @param nonce                 The nonce to consume.
     * @param maxUses               The maximum number of times the nonce can be used.
     */
    function _useNonce(address user, uint160 nonce, uint96 maxUses) internal {
        // load nonce data
        mapping(uint160 => bool) storage _usedNonces = usedNonces[user];
        uint96 _nonceUses = numNonceUses[user][nonce];

        // check if nonce has been completely used or cancelled
        if (_usedNonces[nonce]) revert LC_NonceUsed(user, nonce);

        if (_nonceUses + 1 == maxUses) {
            // if this is the last time nonce can be used, mark the nonce as completely used
            // and update the number of times it has been used to the maxUses
            _usedNonces[nonce] = true;
            numNonceUses[user][nonce] = maxUses;

            emit NonceUsed(user, nonce);
        } else {
            // if this nonce usage is not the last use and is not over the maxUses,
            // increment the numNonceUses mapping
            numNonceUses[user][nonce]++;
        }
    }

    /**
     * @dev Mint a borrower and lender note together - easier to make sure
     *      they are synchronized.
     *
     * @param loanId                The token ID to mint.
     * @param borrower              The address of the recipient of the borrower note.
     * @param lender                The address of the recipient of the lender note.
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
     * @dev Burn a borrowerNote. This function will also burn the lenderNote if the
     *      noteReceipt balance is zero.
     *
     * @param loanId                The token ID to burn.
     */
    function _burnLoanNotes(uint256 loanId) internal {
        if (noteReceipts[loanId].amount == 0) {
            lenderNote.burn(loanId);
        }
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

    /**
     * @dev Perform an ERC20 transferFrom, if the specified amount is nonzero - else no-op.
     *
     * @param token                 The token to transfer.
     * @param from                  The address sending the tokens.
     * @param amount                The amount of tokens to transfer.
     */
    function _collectIfNonzero(
        IERC20 token,
        address from,
        uint256 amount
    ) internal {
        if (amount > 0) token.safeTransferFrom(from, address(this), amount);
    }

    /**
     * @dev Blocks the contract from unpausing once paused.
     */
    function _unpause() internal override whenPaused {
        revert LC_Shutdown();
    }
}
