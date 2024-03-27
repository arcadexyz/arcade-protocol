// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @title LoanLibrary
 * @author Non-Fungible Technologies, Inc.
 *
 * Contains all data types used across Arcade lending contracts.
 */
library LoanLibrary {
    /**
     * @dev Enum describing the current state of a loan.
     * State change flow:
     * Created -> Active -> Repaid
     *                   -> Defaulted
     */
    enum LoanState {
        // We need a default that is not 'Created' - this is the zero value
        DUMMY_DO_NOT_USE,
        // The loan has been initialized, funds have been delivered to the borrower and the collateral is held.
        Active,
        // The loan has been repaid, and the collateral has been returned to the borrower. This is a terminal state.
        Repaid,
        // The loan was delinquent and collateral claimed by the lender. This is a terminal state.
        Defaulted
    }

    /**
     * @dev The raw terms of a loan.
     */
    struct LoanTerms {
        /// @dev Packed variables
        // Interest expressed as an APR. Input conversion:
        // 1 = .0001 = .01% APR (min)
        // 100 = .01 = 1% APR
        // 1000 = 0.1 = 10% APR
        // 100,000,000 = 10,000 = 1,000,000% APR (max)
        uint32 interestRate;
        // The number of seconds representing relative due date of the loan.
        // Max is 94,608,000, fits in 96 bits
        uint64 durationSecs;
        // The token ID of the address holding the collateral.
        // Can be an AssetVault, or the NFT contract for unbundled collateral
        address collateralAddress;
        // Timestamp for when signature for terms expires
        uint96 deadline;
        // The payable currency for the loan principal and interest.
        address payableCurrency;
        /// @dev Full-slot variables
        // The amount of principal in terms of the payableCurrency.
        uint256 principal;
        // The token ID of the collateral.
        uint256 collateralId;
        // Affiliate code used to start the loan.
        bytes32 affiliateCode;
    }

    /**
     * @dev Modification of loan terms, used for signing only.
     *      Instead of a collateralId, a list of predicates
     *      is defined by 'bytes' in items.
     */
    struct LoanTermsWithItems {
        /// @dev Packed variables
        // Interest expressed as an APR. Input conversion:
        // 1 = .0001 = .01% APR (min)
        // 100 = .01 = 1% APR
        // 1000 = 0.1 = 10% APR
        // 100,000,000 = 10,000 = 1,000,000% APR (max)
        uint32 interestRate;
        // The number of seconds representing relative due date of the loan.
        // Max is 94,608,000, fits in 96 bits
        uint64 durationSecs;
        // The tokenID of the address holding the collateral
        address collateralAddress;
        // Timestamp for when signature for terms expires
        uint96 deadline;
        // The payable currency for the loan principal and interest.
        address payableCurrency;
        /// @dev Full-slot variables
        // The amount of principal in terms of the payableCurrency.
        uint256 principal;
        // Affiliate code used to start the loan.
        bytes32 affiliateCode;
        // An encoded list of predicates, along with their verifiers.
        bytes items;
    }

    /**
     * @dev Predicate for item-based verifications
     */
    struct Predicate {
        // The encoded predicate, to decoded and parsed by the verifier contract.
        bytes data;
        // The verifier contract.
        address verifier;
    }

    /**
     * @dev Snapshot of lending fees at the time of loan creation.
     */
    struct FeeSnapshot {
        // The fee taken from the borrower's interest repayment.
        uint16 lenderInterestFee;
        // The fee taken from the borrower's principal repayment.
        uint16 lenderPrincipalFee;
    }

    /**
     * @dev The data of a loan. This is stored once the loan is Active
     */
    struct LoanData {
        /// @dev Packed variables
        // The current state of the loan.
        LoanState state;
        // The fee taken from the borrower's interest repayment.
        uint16 lenderInterestFee;
        // The fee taken from the borrower's principal repayment.
        uint16 lenderPrincipalFee;
        // Start date of the loan, using block.timestamp.
        uint64 startDate;
        // last time interest was accrued
        uint64 lastAccrualTimestamp;
        /// @dev Full-slot variables
        // The raw terms of the loan.
        LoanTerms terms;
        // total principal minus amount of principal repaid
        uint256 balance;
        // total interest paid
        uint256 interestAmountPaid;
    }
}
