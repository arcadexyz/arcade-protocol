// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "../libraries/LoanLibrary.sol";

/**
 * @title LendingErrors
 * @author Non-Fungible Technologies, Inc.
 *
 * This file contains custom errors for the core lending protocol contracts, with errors
 * prefixed by the contract that throws them (e.g., "OC_" for OriginationController).
 * Errors located in one place to make it possible to holistically look at all
 * protocol failure cases.
 */

// ================================= ORIGINATION CONFIGURATION =====================================
/// @notice All errors prefixed with OCC_, to separate from other contracts in the protocol.

/**
 * @notice Zero address passed in where not allowed.
 *
 * @param addressType                  The name of the parameter for which a zero address was provided.
 */
error OCC_ZeroAddress(string addressType);

/**
 *  @notice Error message for when a currency is not whitelisted
 *
 * @param currency              The address of the currency that is not whitelisted.
 */
error OCC_NotWhitelisted(address currency);

/**
 * @notice Provided token array does not hold any token addresses.
 */
error OCC_ZeroArrayElements();

/**
 * @notice Provided token array holds more than 50 token addresses.
 */
error OCC_ArrayTooManyElements();

/**
 * @notice Two related parameters for batch operations did not match in length.
 */
error OCC_BatchLengthMismatch();

/**
 * @notice Provided payable currency address is not approved for lending.
 *
 * @param payableCurrency       ERC20 token address supplied in loan terms.
 */
error OCC_InvalidCurrency(address payableCurrency);

/**
 * @notice Principal must be greater than 9999 Wei.
 *
 * @param principal                     Principal in ether.
 */
error OCC_PrincipalTooLow(uint256 principal);

/**
 * @notice Loan duration must be greater than 1hr and less than 3yrs.
 *
 * @param durationSecs                 Total amount of time in seconds.
 */
error OCC_LoanDuration(uint256 durationSecs);

/**
 * @notice Interest rate must be greater than or equal to 1 (0.01%) and less than or equal
 *         to 1e8 (1,000,000%).
 *
 * @param interestRate                  Interest rate in bps.
 */
error OCC_InterestRate(uint256 interestRate);

/**
 * @notice Signature must not be expired.
 *
 * @param deadline                      Deadline in seconds.
 */
error OCC_SignatureIsExpired(uint256 deadline);

/**
 * @notice Provided collateral address is not approved for lending.
 *
 * @param collateralAddress       ERC721 or ERC1155 token address supplied in loan terms.
 */
error OCC_InvalidCollateral(address collateralAddress);

// ==================================== ORIGINATION CONTROLLER ======================================
/// @notice All errors prefixed with OC_, to separate from other contracts in the protocol.

/**
 * @notice Zero address passed in where not allowed.
 *
 * @param addressType                  The name of the parameter for which a zero address was provided.
 */
error OC_ZeroAddress(string addressType);

/**
 * @notice Ensure valid loan state for loan lifecycle operations.
 *
 * @param state                         Current state of a loan according to LoanState enum.
 */
error OC_InvalidState(LoanLibrary.LoanState state);

/**
 * @notice One of the predicates for item verification failed.
 *
 * @param borrower                      The address of the borrower.
 * @param lender                        The address of the lender.
 * @param verifier                      The address of the verifier contract.
 * @param collateralAddress             The address of the collateral token.
 * @param collateralId                  The token ID of the collateral.
 * @param data                          The verification data (to be parsed by verifier).
 */
error OC_PredicateFailed(
    address borrower,
    address lender,
    address verifier,
    address collateralAddress,
    uint256 collateralId,
    bytes data
);

/**
 * @notice A caller attempted to approve themselves.
 *
 * @param caller                        The caller of the approve function.
 */
error OC_SelfApprove(address caller);

/**
 * @notice A caller attempted to originate a loan with their own signature.
 *
 * @param caller                        The caller of the approve function, who was also the signer.
 */
error OC_ApprovedOwnLoan(address caller);

/**
 * @notice The signature could not be recovered to the counterparty or approved party.
 *
 * @param target                        The target party of the signature, which should either be the signer,
 *                                      or someone who has approved the signer.
 * @param signer                        The signer determined from ECDSA.recover.
 */
error OC_InvalidSignature(address target, address signer);

/**
 * @notice The verifier contract specified in a predicate has not been whitelisted.
 *
 * @param verifier                      The verifier the caller attempted to use.
 */
error OC_InvalidVerifier(address verifier);

/**
 * @notice The function caller was neither borrower or lender, and was not approved by either.
 *
 * @param caller                        The unapproved function caller.
 */
error OC_CallerNotParticipant(address caller);

/**
 * @notice Signer is attempting to take the wrong side of the loan.
 *
 * @param signer                       The address of the external signer.
 */
error OC_SideMismatch(address signer);

/**
 * @notice New currency does not match for a loan rollover request.
 *
 * @param oldCurrency                   The currency of the active loan.
 * @param newCurrency                   The currency of the new loan.
 */
error OC_RolloverCurrencyMismatch(address oldCurrency, address newCurrency);

/**
 * @notice New collateral does not match for a loan rollover request.
 *
 * @param oldCollateralAddress          The address of the active loan's collateral.
 * @param newCollateralAddress          The token ID of the active loan's collateral.
 * @param oldCollateralId               The address of the new loan's collateral.
 * @param newCollateralId               The token ID of the new loan's collateral.
 */
error OC_RolloverCollateralMismatch(
    address oldCollateralAddress,
    uint256 oldCollateralId,
    address newCollateralAddress,
    uint256 newCollateralId
);

// ================================== ORIGINATION CONTROLLER MIGRATE ====================================
/// @notice All errors prefixed with OCM_, to separate from other contracts in the protocol.

/**
 * @notice The flash loan callback caller is not recognized. The caller must be the flash
 *         loan provider.
 *
 * @param caller                  The address of the caller.
 * @param lendingPool             Expected address of the flash loan provider.
 */
error OCM_UnknownCaller(address caller, address lendingPool);

/**
 * @notice Only the holder of the borrowerNote can rollover their loan.
 */
error OCM_CallerNotBorrower();

/**
 * @notice Contract is paused, rollover operations are blocked.
 */
error OCM_Paused();

/**
 * @notice The rollover contract is already in the specified pause state.
 */
error OCM_StateAlreadySet();

/**
 * @notice Borrower address is not cached of the flash loan callback.
 */
error OCM_BorrowerNotCached();

/**
 * @notice The borrower address saved in the rollover contract is not the same as the
 *         borrower address provided in the flash loan operation data. The initiator of
 *         the flash loan must be the rollover contract.
 *
 * @param providedBorrower        Borrower address passed in the flash loan operation data.
 * @param cachedBorrower          Borrower address saved in the rollover contract.
 */
error OCM_UnknownBorrower(address providedBorrower, address cachedBorrower);

/**
 * @notice The borrower state must be address(0) to initiate a rollover sequence.
 *
 * @param borrower                The borrower address.
 */
error OCM_BorrowerNotReset(address borrower);

/**
 * @notice Ensure valid loan state for loan lifecycle operations.
 *
 * @param state                         Current state of a loan according to LoanState enum.
 */
error OCM_InvalidState(uint8 state);

/**
 * @notice Signer is attempting to take the wrong side of the loan.
 *
 * @param signer                       The address of the external signer.
 */
error OCM_SideMismatch(address signer);

/**
 * @notice Signature must not be expired.
 *
 * @param deadline                      Deadline in seconds.
 */
error OCM_SignatureIsExpired(uint256 deadline);

/**
 * @notice New currency does not match for a loan migration request.
 *
 * @param oldCurrency                   The currency of the active loan.
 * @param newCurrency                   The currency of the new loan.
 */
error OCM_CurrencyMismatch(address oldCurrency, address newCurrency);

/**
 * @notice New collateral does not match for a loan migration request.
 *
 * @param oldCollateralAddress          The address of the active loan's collateral.
 * @param newCollateralAddress          The token ID of the active loan's collateral.
 * @param oldCollateralId               The address of the new loan's collateral.
 * @param newCollateralId               The token ID of the new loan's collateral.
 */
error OCM_CollateralMismatch(
    address oldCollateralAddress,
    uint256 oldCollateralId,
    address newCollateralAddress,
    uint256 newCollateralId
);

/**
 * @notice Principal must be greater than 9999 Wei.
 *
 * @param principal                     Principal in ether.
 */
error OCM_PrincipalTooLow(uint256 principal);

/**
 * @notice Loan duration must be greater than 1hr and less than 3yrs.
 *
 * @param durationSecs                 Total amount of time in seconds.
 */
error OCM_LoanDuration(uint256 durationSecs);

/**
 * @notice Interest rate must be greater than or equal to 1 (0.01%) and less than or equal
 *         to 1e8 (1,000,000%).
 *
 * @param interestRate                  Interest rate in bps.
 */
error OCM_InterestRate(uint256 interestRate);

// ================================= REFINANCE CONTROLLER =====================================
/// @notice All errors prefixed with REFI_, to separate from other contracts in the protocol.

/**
 * @notice Zero address passed in where not allowed.
 *
 * @param addressType                  The name of the parameter for which a zero address was provided.
 */
error REFI_ZeroAddress(string addressType);

/**
 * @notice Ensure valid loan state for loan lifecycle operations.
 *
 * @param state                         Current state of a loan according to LoanState enum.
 */
error REFI_InvalidState(LoanLibrary.LoanState state);

/**
 * @notice New collateral does not match for a loan refinance request.
 *
 * @param oldCollateralAddress          The address of the active loan's collateral.
 * @param newCollateralAddress          The token ID of the active loan's collateral.
 * @param oldCollateralId               The address of the new loan's collateral.
 * @param newCollateralId               The token ID of the new loan's collateral.
 */
error REFI_CollateralMismatch(
    address oldCollateralAddress,
    uint256 oldCollateralId,
    address newCollateralAddress,
    uint256 newCollateralId
);

/**
 * @notice New currency does not match for a loan refinance request.
 *
 * @param oldCurrency                   The currency of the active loan.
 * @param newCurrency                   The currency of the new loan.
 */
error REFI_CurrencyMismatch(address oldCurrency, address newCurrency);

/**
 * @notice A minimum of 2 days must have passed since the loan was last originated.
 *
 * @param earliestRefinanceTime         The earliest time at which the loan can be refinanced.
 */
error REFI_TooEarly(uint256 earliestRefinanceTime);

/**
 * @notice Interest rate must be greater than or equal to 1 (0.01%) and have a minimum
 *         of 10% lower APR than the active loan
 *
 * @param interestRate                  Interest rate in bps.
 */
error REFI_InterestRate(uint256 interestRate);

/**
 * @notice For refinancing, the new due date cannot be shorter than old due date
 *
 * @param oldDueDate                  The due date of the active loan.
 * @param newDueDate                  The due date of the refinance terms.
 */
error REFI_LoanDuration(uint256 oldDueDate, uint256 newDueDate);

/**
 * @notice For refinancing, the caller cannot be the existing lender.
 *
 * @param lender                     The address of the existing lender and caller.
 */
error REFI_SameLender(address lender);

/**
 * @notice For refinancing, the principal cannot increase.
 *
 * @param oldPrincipal                  The principal of the active loan.
 * @param newPrincipal                  The principal of the refinance terms.
 */
error REFI_PrincipalIncrease(uint256 oldPrincipal, uint256 newPrincipal);

// ==================================== ITEMS VERIFIER ======================================
/// @notice All errors prefixed with IV_, to separate from other contracts in the protocol.

/**
 * @notice The predicate payload was decoded successfully, but list of predicates is empty.
 */
error IV_NoPredicates();

/**
 * @notice Provided SignatureItem is missing an address.
 */
error IV_ItemMissingAddress();

/**
 * @notice Provided SignatureItem has an invalid collateral type.
 * @dev    Should never actually fire, since cType is defined by an enum, so will fail on decode.
 *
 * @param asset                        The NFT contract being checked.
 * @param cType                        The collateralType provided.
 */
error IV_InvalidCollateralType(address asset, uint256 cType);

/**
 * @notice Provided signature item with no required amount. For single ERC721s, specify 1.
 *
 * @param asset                         The NFT contract being checked.
 * @param amount                        The amount provided (should be 0).
 */
error IV_NoAmount(address asset, uint256 amount);

/**
 * @notice Provided a wildcard for a non-ERC721.
 *
 * @param asset                         The NFT contract being checked.
 */
error IV_InvalidWildcard(address asset);

/**
 * @notice The provided token ID is out of bounds for the given collection.
 *
 * @param tokenId                       The token ID provided.
 */
error IV_InvalidTokenId(int256 tokenId);

/**
 * @notice The provided project ID does not exist on the target contract. Only
 *         used for ArtBlocks.
 *
 * @param projectId                     The project ID provided.
 * @param nextProjectId                 The contract's reported nextProjectId.
 */
error IV_InvalidProjectId(uint256 projectId, uint256 nextProjectId);

/**
 * @notice The provided collateralId converts to a vault, but
 *         the vault's address does not convert back to the provided collateralId
 *         when casted to a uint256.
 */
error IV_InvalidCollateralId(uint256 collateralId);

// ==================================== REPAYMENT CONTROLLER ======================================
/// @notice All errors prefixed with RC_, to separate from other contracts in the protocol.

/**
 * @notice Zero address passed in where not allowed.
 *
 * @param addressType                  The name of the parameter for which a zero address was provided.
 */
error RC_ZeroAddress(string addressType);

/**
 * @notice Could not dereference loan from loan ID.
 *
 * @param target                     The loanId being checked.
 */
error RC_CannotDereference(uint256 target);

/**
 * @notice Ensure valid loan state for loan lifecycle operations.
 *
 * @param state                         Current state of a loan according to LoanState enum.
 */
error RC_InvalidState(LoanLibrary.LoanState state);

/**
 * @notice Caller is not the owner of lender note.
 *
 * @param lender                     The owner of the lender note.
 * @param caller                     Msg.sender of the function call.
 */
error RC_OnlyLender(address lender, address caller);

/**
 * @notice Repayment amount specified is less than interest owed.
 *
 * @param amount                        Amount to repay.
 * @param interestOwed                  Amount of interest owed on the loan.
 */
error RC_InvalidRepayment(uint256 amount, uint256 interestOwed);

/**
 * @notice Repayment amount must be greater than 0.
 */
error RC_ZeroAmount();

// ====================================== LOAN CORE ======================================
/// @notice All errors prefixed with LC_, to separate from other contracts in the protocol.

/**
 * @notice Zero address passed in where not allowed.
 *
 * @param addressType                  The name of the parameter for which a zero address was provided.
 */
error LC_ZeroAddress(string addressType);

/// @notice Borrower address is same as lender address.
error LC_ReusedNote();

/// @notice Zero amount passed in where not allowed.
error LC_ZeroAmount();

/**
 * @notice Check collateral is not already used in a active loan.
 *
 * @param collateralAddress             Address of the collateral.
 * @param collateralId                  ID of the collateral token.
 */
error LC_CollateralInUse(address collateralAddress, uint256 collateralId);

/**
 * @notice The reported settlements are invalid, and LoanCore would lose tokens
 *         attempting to perform the requested operations.
 *
 *
 * @param payout                        Amount of tokens to be paid out.
 * @param collected                     Amount of tokens to collect - should be fewer than payout.
 */
error LC_CannotSettle(uint256 payout, uint256 collected);

/**
 * @notice User attempted to withdraw a pending balance that was in excess
 *         of what is available.
 *
 * @param amount                        Amount of tokens to be withdrawn.
 * @param available                     Amount of tokens available to withdraw.
 */
error LC_CannotWithdraw(uint256 amount, uint256 available);

/**
 * @notice Two arrays were provided that must be of matching length, but were not.
 *
 */
error LC_ArrayLengthMismatch();

/**
 * @notice A proposed affiliate split was submitted that is over the maximum.
 *
 * @param splitBps                     The proposed affiliate split.
 * @param maxSplitBps                  The maximum allowed affiliate split.
 *
 */
error LC_OverMaxSplit(uint96 splitBps, uint96 maxSplitBps);

/**
 * @notice Ensure valid loan state for loan lifecycle operations.
 *
 * @param state                         Current state of a loan according to LoanState enum.
 */
error LC_InvalidState(LoanLibrary.LoanState state);

/**
 * @notice Loan duration has not expired.
 *
 * @param dueDate                       Timestamp of the end of the loan duration.
 */
error LC_NotExpired(uint256 dueDate);

/**
 * @notice User address and the specified nonce have already been used.
 *
 * @param user                          Address of collateral owner.
 * @param nonce                         Unique identifier for a loan signature.
 */
error LC_NonceUsed(address user, uint160 nonce);

/**
 * @notice The max uses for the specified nonce has been reached.
 *
 * @param nonce                         Unique identifier for a loan signature.
 * @param maxUses                       The maximum number of times this nonce can be used.
 */
error LC_MaxNonceUses(uint160 nonce, uint96 maxUses);

/**
 * @notice Protocol attempted to set an affiliate code which already exists. Affiliate
 *         codes are immutable.
 *
 * @param affiliateCode                 The affiliate code being set.
 */
error LC_AffiliateCodeAlreadySet(bytes32 affiliateCode);

/**
 * @notice Specified note token ID does not have a redeemable receipt.
 *
 * @param loanId                     The loanId being checked.
 */
error LC_NoReceipt(uint256 loanId);

/**
 * @notice Only Loan Core contract can call this function.
 */
error LC_CallerNotLoanCore();

/**
 * @notice The loan core contract has been irreversibly shut down.
 */
error LC_Shutdown();

/**
 * @notice The payment to principal must be less than the balance due.
 */
error LC_ExceedsBalance(uint256 paymentToPrincipal, uint256 balance);

/**
 * @notice LoanCore is holding a withdrawal balance for this loan. The collateral
 * cannot be claimed until the available balance is withdrawn.
 */
error LC_AwaitingWithdrawal(uint256 availableAmount);

// ==================================== PROMISSORY NOTE ======================================
/// @notice All errors prefixed with PN_, to separate from other contracts in the protocol.

/**
 * @notice Zero address passed in where not allowed.
 *
 * @param addressType                  The name of the parameter for which a zero address was provided.
 */
error PN_ZeroAddress(string addressType);

/**
 * @notice Caller of mint function must have the MINTER_ROLE in AccessControl.
 *
 * @param caller                        Address of the function caller.
 */
error PN_MintingRole(address caller);

/**
 * @notice Caller of burn function must have the BURNER_ROLE in AccessControl.
 *
 * @param caller                        Address of the function caller.
 */
error PN_BurningRole(address caller);

/**
 * @notice Non-existent token id provided as argument.
 *
 * @param tokenId                       The ID of the token to lookup the URI for.
 */
error PN_DoesNotExist(uint256 tokenId);

// ==================================== FEE CONTROLLER ======================================
/// @notice All errors prefixed with FC_, to separate from other contracts in the protocol.

/**
 * @notice Caller attempted to set a lending fee which is larger than the global maximum.
 */
error FC_LendingFeeOverMax(bytes32 selector, uint256 fee, uint256 maxFee);

/**
 * @notice Caller attempted to set a vault mint fee which is larger than the global maximum.
 */
error FC_VaultMintFeeOverMax(uint256 fee, uint256 maxFee);

// ==================================== ERC721 PERMIT ======================================
/// @notice All errors prefixed with ERC721P_, to separate from other contracts in the protocol.

/**
 * @notice Deadline for the permit has expired.
 *
 * @param deadline                      Permit deadline parameter as a timestamp.
 */
error ERC721P_DeadlineExpired(uint256 deadline);

/**
 * @notice Address of the owner to also be the owner of the tokenId.
 *
 * @param owner                        Owner parameter for the function call.
 */
error ERC721P_NotTokenOwner(address owner);

/**
 * @notice Invalid signature.
 *
 * @param signer                        Signer recovered from ECDSA signature hash.
 */
error ERC721P_InvalidSignature(address signer);


