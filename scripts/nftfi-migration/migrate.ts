/* eslint no-unused-vars: 0 */
import "@nomiclabs/hardhat-ethers";
import hre, { ethers } from "hardhat";
import { BigNumber } from "ethers";

import {
    SECTION_SEPARATOR,
    SUBSECTION_SEPARATOR
} from "../utils/constants";

import {
    ERC20,
    LP1Migration,
} from "../../typechain";

import { main as deploy } from "../deploy/deploy";
import { doWhitelisting } from "../deploy/whitelisting";
import { setupRoles } from "../deploy/setup-roles";

import {
    BORROWER,
    PAYABLE_CURRENCY,
    WHALE,
    BALANCER_ADDRESS,
    LOAN_ID,
    LENDER_SPECIFIED_COLLATERAL_ID,
    LENDER_SPECIFIED_COLLATERAL,
    NONCE,
    V3_LOAN_PRINCIPAL,
    V3_LOAN_INTEREST_RATE,
    NFTFI_REPAYMENT_AMOUNT,
    NFTFI_OBLIGATION_RECEIPT_TOKEN_ADDRESS,
    NFTFI_SMARTNFT_ID,
    DIRECT_LOAN_FIXED_OFFER_ABI,
    NFTFI_OBLIGATION_RECEIPT_TOKEN_ABI,
    NFTFI_DIRECT_LOAN_FIXED_OFFER_ADDRESS,
    MIN_LOAN_PRINCIPAL,
} from "./config";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms } from "../../test/utils/types";

/**
 * This script deploys V3 lending protocol and sets up roles and permissions. Deploys
 * the LP1Migration contract, then, executes a NftFi -> V3 rollover using a
 * Balancer Flashloan to rollover an active NFTFI loan on mainnet. Before running this
 * script, make sure the nftfi-rollover/config.ts file is updated with valid values
 * from mainnet.
 *
 * Run this script with the following command:
 * `FORK_MAINNET=true npx hardhat run scripts/nftfi-rollover/nftfi-rollover.ts`
 */

export async function main(): Promise<void> {
    // ================================== Deploy V3 Lending Protocol ==================================
    // Deploy V3 contracts
    console.log(SECTION_SEPARATOR);
    console.log("Deploying V3 contracts...");

    const resources = await deploy();

    const {
        originationController,
        feeController,
        loanCore,
        borrowerNote
    } = resources;

    console.log(SECTION_SEPARATOR);
    console.log("Whitelisting tokens...");

    await doWhitelisting(resources);

    // Whitelist collateral and payable currency used in the new loan terms
    console.log(SUBSECTION_SEPARATOR);
    console.log(`Add collateral and payable currency to V3 OriginationController...`);
    const addCollateral = await originationController.setAllowedCollateralAddresses(
        [LENDER_SPECIFIED_COLLATERAL],
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

    // ================================== Execute V2 -> V3 Rollover ==================================

    console.log("Perform V2 -> V3 rollover...\n");

    // ============= Setup ==============
    // use accounts[0] as new lender
    const [newLender] = await hre.ethers.getSigners();
    console.log("New lender address:", newLender.address);

    // Deploy NftFI -> v3 rollover contract and set the flash loan fee value
    console.log(SUBSECTION_SEPARATOR);
    console.log("Deploying rollover contract...");

    const contracts = {
        feeControllerV3: `${feeController.address}`,
        originationControllerV3: `${originationController.address}`,
        loanCoreV3: `${loanCore.address}`,
        borrowerNoteV3: `${borrowerNote.address}`,
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
        params: [BORROWER],
    });
    const whale = await hre.ethers.getSigner(WHALE);
    const borrower = await hre.ethers.getSigner(BORROWER);

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

    console.log("Borrower mints NFTFI obligationReceiptToken and approve it to rollover contract...");
    const directLoanFixedOffer = new ethers.Contract(
        NFTFI_DIRECT_LOAN_FIXED_OFFER_ADDRESS,
        DIRECT_LOAN_FIXED_OFFER_ABI,
        (await hre.ethers.getSigners())[0],
    );

    const mintObligationReceipt = await directLoanFixedOffer.connect(borrower).mintObligationReceipt(LOAN_ID);
    await mintObligationReceipt.wait();

    const obligationReceiptToken = new ethers.Contract(
        NFTFI_OBLIGATION_RECEIPT_TOKEN_ADDRESS,
        NFTFI_OBLIGATION_RECEIPT_TOKEN_ABI,
        (await hre.ethers.getSigners())[0],
    );
    await obligationReceiptToken.connect(borrower).approve(migration.address, NFTFI_SMARTNFT_ID);
    console.log(SUBSECTION_SEPARATOR);

    // if new loan will not cover flash loan repayment, then borrower needs to cover the difference
    const flashLoanAmountDue = NFTFI_REPAYMENT_AMOUNT.add(NFTFI_REPAYMENT_AMOUNT.mul(flashLoanFee).div(10000));
    if (V3_LOAN_PRINCIPAL.lt(flashLoanAmountDue)) {
        const difference = flashLoanAmountDue.sub(V3_LOAN_PRINCIPAL);
        await payableCurrency.connect(whale).transfer(borrower.address, difference);
        await payableCurrency.connect(borrower).approve(migration.address, difference);
    }
    console.log(SUBSECTION_SEPARATOR);

    console.log("New Lender creates V3 signature...");
    // collection wide offer parameters
    const newLoanTerms: LoanTerms = {
        durationSecs: 86400,
        deadline: Math.floor(Date.now() / 1000) + 100_000,
        proratedInterestRate: V3_LOAN_INTEREST_RATE,
        principal: V3_LOAN_PRINCIPAL,
        collateralAddress: LENDER_SPECIFIED_COLLATERAL,
        collateralId: LENDER_SPECIFIED_COLLATERAL_ID,
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

    console.log("Execute NFTFI -> V3 rollover...");
    const tx = await migration
        .connect(borrower)
        .migrateLoan(LOAN_ID, newLoanTerms, newLender.address, NONCE, sig.v, sig.r, sig.s);

    // send transaction
    console.log("✅ Transaction hash:", tx.hash);

    console.log(SECTION_SEPARATOR);
    console.log("Rollover successful 🎉\n");
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
