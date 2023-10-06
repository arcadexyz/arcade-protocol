/* eslint no-unused-vars: 0 */
import "@nomiclabs/hardhat-ethers";
import hre, { ethers } from "hardhat";
import { BigNumber } from "ethers";

import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../utils/constants";

import { ERC20, LP1Migration } from "../../typechain";

import { main as deploy } from "../deploy/deploy";
import { doWhitelisting } from "../deploy/whitelisting";
import { setupRoles } from "../deploy/setup-roles";

import {
    BUNDLE_BORROWER,
    PAYABLE_CURRENCY,
    WHALE,
    BALANCER_ADDRESS,
    BUNDLE_LOAN_ID,
    BUNDLE_LENDER_SPECIFIED_COLLATERAL_ID,
    BUNDLE_LENDER_SPECIFIED_COLLATERAL,
    NONCE,
    V3_LOAN_PRINCIPAL,
    V3_LOAN_INTEREST_RATE,
    NFTFI_BUNDLE_REPAYMENT_AMOUNT,
    NFTFI_OBLIGATION_RECEIPT_TOKEN_ADDRESS,
    NFTFI_BUNDLE_SMARTNFT_ID,
    DIRECT_LOAN_FIXED_OFFER_REDEPLOY_ABI,
    NFTFI_OBLIGATION_RECEIPT_TOKEN_ABI,
    NFTFI_DIRECT_LOAN_FIXED_OFFER_REDEPLOY_ADDRESS,
    MIN_LOAN_PRINCIPAL,
} from "./config";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms } from "../../test/utils/types";

/**
 * This script deploys V3 lending protocol and sets up roles and permissions. Deploys
 * the LP1Migration contract, then, executes a NftFi bundle -> V3 rollover using a
 * Balancer Flashloan to rollover an active NFTFI loan on mainnet. Before running this
 * script, make sure the nftfi-migration/config.ts file is updated with valid values
 * from mainnet.
 *
 * Run this script with the following command:
 * `FORK_MAINNET=true npx hardhat run scripts/nftfi-migration/migrate-bundle.ts`
 */

export async function main(): Promise<void> {
    // ================================== Deploy V3 Lending Protocol ==================================
    // Deploy V3 contracts
    console.log(SECTION_SEPARATOR);
    console.log("Deploying V3 contracts...");

    const resources = await deploy();

    const { originationController, feeController, loanCore, borrowerNote } = resources;

    console.log(SECTION_SEPARATOR);
    console.log("Whitelisting tokens...");

    await doWhitelisting(resources);

    // Whitelist collateral and payable currency used in the new loan terms
    console.log(SUBSECTION_SEPARATOR);
    console.log(`Add collateral and payable currency to V3 OriginationController...`);
    const addCollateral = await originationController.setAllowedCollateralAddresses(
        [BUNDLE_LENDER_SPECIFIED_COLLATERAL],
        [true],
    );
    await addCollateral.wait();
    const addPayableCurrency = await originationController.setAllowedPayableCurrencies(
        [PAYABLE_CURRENCY],
        [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }],
    );
    await addPayableCurrency.wait();

    console.log(SECTION_SEPARATOR);
    console.log("Assigning roles...");

    await setupRoles(resources);

    // ================================== Execute NFTFI -> V3 Migration ==================================

    console.log("Perform NFTFI bundle -> V3 migration...\n");

    // ============= Setup ==============
    // use accounts[0] as new lender
    const [newLender] = await hre.ethers.getSigners();
    console.log("New lender address:", newLender.address);

    // Deploy NftFI bundle -> v3 rollover contract and set the flash loan fee value
    console.log(SUBSECTION_SEPARATOR);
    console.log("Deploying migration contract...");

    // Using mainnet addresses for migration
    const contracts = {
        directLoanFixedOffer: "0x8252Df1d8b29057d1Afe3062bf5a64D503152BC8", // for bundle loans
        loanCoordinator: "0x0C90C8B4aa8549656851964d5fB787F0e4F54082",
        feeControllerV3: feeController.address,
        originationControllerV3: originationController.address,
        loanCoreV3: loanCore.address,
        borrowerNoteV3: borrowerNote.address,
    };

    const factory = await ethers.getContractFactory("LP1Migration");
    const migration = <LP1Migration>await factory.deploy(BALANCER_ADDRESS, contracts);
    await migration.deployed();
    console.log("LP1Migration deployed to:", migration.address);
    const flashLoanFee: BigNumber = BigNumber.from("0"); // 0% flash loan fee on Balancer
    console.log("Owner:", await migration.owner());

    // impersonate accounts
    console.log(SUBSECTION_SEPARATOR);
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [WHALE],
    });
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [BUNDLE_BORROWER],
    });
    const whale = await hre.ethers.getSigner(WHALE);
    const borrower = await hre.ethers.getSigner(BUNDLE_BORROWER);

    const erc20Factory = await ethers.getContractFactory("ERC20");
    const payableCurrency = <ERC20>erc20Factory.attach(`${PAYABLE_CURRENCY}`);

    // Distribute ETH and payable currency by impersonating a whale account
    console.log("Whale distributes ETH and payable currency...");
    await whale.sendTransaction({ to: borrower.address, value: ethers.utils.parseEther("10") });
    await whale.sendTransaction({ to: newLender.address, value: ethers.utils.parseEther("10") });
    await payableCurrency.connect(whale).transfer(newLender.address, V3_LOAN_PRINCIPAL);
    console.log(SUBSECTION_SEPARATOR);

    console.log("New lender approves payable currency to V3 LoanCore...");
    await payableCurrency.connect(newLender).approve(loanCore.address, V3_LOAN_PRINCIPAL);
    console.log(SUBSECTION_SEPARATOR);

    console.log("Borrower mints NFTFI obligationReceiptToken and approves it to rollover contract...");
    const directLoanFixedOffer = new ethers.Contract(
        NFTFI_DIRECT_LOAN_FIXED_OFFER_REDEPLOY_ADDRESS,
        DIRECT_LOAN_FIXED_OFFER_REDEPLOY_ABI,
        (await hre.ethers.getSigners())[0],
    );

    const mintObligationReceipt = await directLoanFixedOffer.connect(borrower).mintObligationReceipt(BUNDLE_LOAN_ID);
    await mintObligationReceipt.wait();

    const obligationReceiptToken = new ethers.Contract(
        NFTFI_OBLIGATION_RECEIPT_TOKEN_ADDRESS,
        NFTFI_OBLIGATION_RECEIPT_TOKEN_ABI,
        (await hre.ethers.getSigners())[0],
    );

    await obligationReceiptToken.connect(borrower).approve(migration.address, NFTFI_BUNDLE_SMARTNFT_ID);
    console.log(SUBSECTION_SEPARATOR);

    // if new loan will not cover flash loan repayment, then borrower needs to cover the difference
    const flashLoanAmountDue = NFTFI_BUNDLE_REPAYMENT_AMOUNT.add(NFTFI_BUNDLE_REPAYMENT_AMOUNT.mul(flashLoanFee).div(10000));
    if (V3_LOAN_PRINCIPAL.lt(flashLoanAmountDue)) {
        const difference = flashLoanAmountDue.sub(V3_LOAN_PRINCIPAL);
        await payableCurrency.connect(whale).transfer(borrower.address, difference);
        await payableCurrency.connect(borrower).approve(migration.address, difference);
    }

    console.log("New Lender creates V3 signature...");
    // collection wide offer parameters
    const newLoanTerms: LoanTerms = {
        durationSecs: 86400,
        deadline: Math.floor(Date.now() / 1000) + 100_000,
        proratedInterestRate: V3_LOAN_INTEREST_RATE,
        principal: V3_LOAN_PRINCIPAL,
        collateralAddress: BUNDLE_LENDER_SPECIFIED_COLLATERAL,
        collateralId: BUNDLE_LENDER_SPECIFIED_COLLATERAL_ID,
        payableCurrency: PAYABLE_CURRENCY,
        affiliateCode: ethers.constants.HashZero,
    };

    const sig = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        newLoanTerms,
        newLender,
        "3",
        NONCE.toString(),
        "l",
    );
    console.log(SUBSECTION_SEPARATOR);

    // ============= Execute ==============

    console.log("Execute NFTFI bundle -> V3 migration ...");
    const tx = await migration
        .connect(borrower)
        .migrateLoan(BUNDLE_LOAN_ID, newLoanTerms, newLender.address, NONCE, sig.v, sig.r, sig.s);

    // send transaction
    console.log("✅ Transaction hash:", tx.hash);

    console.log(SECTION_SEPARATOR);
    console.log("Migration successful 🎉\n");
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
