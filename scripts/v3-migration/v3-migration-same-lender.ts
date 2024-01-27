import hre, { ethers } from "hardhat";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms, SignatureProperties } from "../../test/utils/types";

import { ERC20 } from "../../typechain";

import { main as deploy } from "../deploy/deploy";
import { doWhitelisting } from "../deploy/whitelisting";
import { setupRoles } from "../deploy/setup-roles";

import { v3LoanCoreAbi, v3RepaymentControllerAbi, v3OriginationControllerAbi } from "./abis/V3Contracts";

import { SECTION_SEPARATOR } from "../utils/constants";
import { V3LoanTerms, createV3LoanTermsSignature } from "./utils";
import { BigNumber } from "ethers";

// V3 contracts
const V3_REPAYMENT_CONTROLLER = "0x74241e1A9c021643289476426B9B70229Ab40D53";
const V3_ORIGINATION_CONTROLLER = "0xB7BFcca7D7ff0f371867B770856FAc184B185878";
const V3_LOAN_CORE = "0x89bc08BA00f135d608bc335f6B33D7a9ABCC98aF";

// payable currency
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DECIMALS = 6;

// actors
const BORROWER = "0xcffc336e6d019c1af58257a0b10bf2146a3f42a4";
const USDC_WHALE = "0x72A53cDBBcc1b9efa39c834A540550e23463AAcB";

// V3 loan context
const V3_LOAN_ID = 1375;

// V4 loan principal
// exact repayment amount is 91997.260273 USDC
// new terms principal minimum is 1 USDC
const NEW_TERMS_PRINCIPAL = ethers.utils.parseUnits("91997.260273", 6);

/**
 * This is a mainnet fork script that migrates an active v3 loan to v4 using the same lender.
 * Adjust the NEW_TERMS_PRINCIPAL parameter to see the difference in repayment amounts.
 *
 * To run:
 * `FORK_MAINNET=true npx hardhat run scripts/v3-migration/v3-migration-same-lender.ts`
 *
 * Ensure the hardhat.config.ts file is configured correctly to fork at `blockNumber: 18852467`
 */
export async function main(): Promise<void> {
    const resources = await deploy();
    console.log("V4 contracts deployed!");

    await doWhitelisting(resources);
    console.log("V4 whitelisting complete!");

    await setupRoles(resources);
    console.log("V4 contracts setup!");

    // Must use the abi to get the contract instance because the current version of
    // the contract is different than the one deployed on mainnet.
    const v3RepaymentController = (
        await ethers.getContractAt(v3RepaymentControllerAbi, V3_REPAYMENT_CONTROLLER)
    );

    const v3OriginationController = (
        await ethers.getContractAt(v3OriginationControllerAbi, V3_ORIGINATION_CONTROLLER)
    );

    const v3LoanCore = await ethers.getContractAt(v3LoanCoreAbi, V3_LOAN_CORE);

    const v3BorrowerNoteAddr = await v3LoanCore.borrowerNote();
    const v3LenderNoteAddr = await v3LoanCore.lenderNote();

    const v3PromissoryNoteFactory = await ethers.getContractFactory("PromissoryNote");

    const v3BorrowerNote = v3PromissoryNoteFactory.attach(v3BorrowerNoteAddr);
    const v3LenderNote = v3PromissoryNoteFactory.attach(v3LenderNoteAddr);

    const erc20Factory = await ethers.getContractFactory("ERC20");
    const payableCurrency = <ERC20>erc20Factory.attach(USDC);

    console.log(SECTION_SEPARATOR);

    const { originationController, lenderNote, borrowerNote } = resources;

    // main actors
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [BORROWER],
    });
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [USDC_WHALE],
    });
    const whale = await ethers.getSigner(USDC_WHALE);
    const borrower = await ethers.getSigner(BORROWER);
    console.log("V3 Borrower: ", borrower.address);

    const v3Lender = await v3LenderNote.ownerOf(V3_LOAN_ID);
    console.log("V3 Lender: ", v3Lender);

    const [newLender] = await ethers.getSigners();
    console.log("New Lender: ", newLender.address);
    console.log();

    // get v3 loan data and repayment amounts
    const v3LoanData = await v3LoanCore.getLoan(V3_LOAN_ID);
    console.log("V3 loan principal: ", ethers.utils.formatUnits(v3LoanData.terms.principal, DECIMALS));
    const v3InterestAmount = await v3RepaymentController.getInterestAmount(
        v3LoanData.terms.principal,
        v3LoanData.terms.proratedInterestRate
    );
    console.log("Interest amount: ", ethers.utils.formatUnits(v3InterestAmount, DECIMALS));
    const v3RepayAmount = v3LoanData.terms.principal.add(v3InterestAmount);
    console.log("Total V3 repayment amount: ", ethers.utils.formatUnits(v3RepayAmount, DECIMALS));
    console.log();

    console.log("Rollover V3 loan to a new lender that will be the same as the v4 lender...");
    // use same terms, update deadline
    const newV3LoanTerms: V3LoanTerms = {
        ...v3LoanData.terms,
        deadline: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    };
    // new lender signs a bid on v3 to rollover this loan
    const newV3Signature = await createV3LoanTermsSignature(
        v3OriginationController.address,
        "OriginationController",
        newV3LoanTerms,
        newLender,
        "3",
        1,
        "l",
    );

    await whale.sendTransaction({ to: borrower.address, value: ethers.utils.parseEther(".5") });
    await whale.sendTransaction({ to: newLender.address, value: ethers.utils.parseEther(".5") });

    // new lender approves v3 origination controller to spend rollover principal
    await payableCurrency.connect(whale).transfer(newLender.address, newV3LoanTerms.principal);
    await payableCurrency.connect(newLender).approve(v3OriginationController.address, newV3LoanTerms.principal);

    // borrower approves v3 origination controller to pull v3 interest amount
    await payableCurrency.connect(whale).transfer(borrower.address, v3InterestAmount);
    await payableCurrency.connect(borrower).approve(v3OriginationController.address, v3InterestAmount);

    const v3lenderBalBefore = await payableCurrency.balanceOf(v3Lender);
    const borrowerBalBefore = await payableCurrency.balanceOf(BORROWER);

    // borrower calls rollover with new lenders bid
    await v3OriginationController.connect(borrower).rolloverLoan(
        V3_LOAN_ID,
        newV3LoanTerms,
        newLender.address,
        newV3Signature,
        1
    );
    const nextLoanId = V3_LOAN_ID + 1;
    const newV3Lender = await v3LenderNote.ownerOf(nextLoanId);
    // revert if newV3Lender is not the same as newLender
    if (newV3Lender !== newLender.address) {
        throw new Error("New V3 lender is not the same as new lender");
    }
    console.log("New V3 loanId: ", nextLoanId);
    const v3lenderBalAfter = await payableCurrency.balanceOf(v3Lender);
    const borrowerBalAfter = await payableCurrency.balanceOf(BORROWER);
    console.log("borrower sent: ", ethers.utils.formatUnits(borrowerBalBefore.sub(borrowerBalAfter), DECIMALS));
    console.log("V3 lender repaid amount: ", ethers.utils.formatUnits(v3lenderBalAfter.sub(v3lenderBalBefore), DECIMALS));
    console.log();

    console.log("Migrate v3 loan to v4. New v4 lender is the same as v3 lender...");

    const newLoanTerms: LoanTerms = {
        interestRate: 1000,
        durationSecs: v3LoanData.terms.durationSecs,
        collateralAddress: v3LoanData.terms.collateralAddress,
        deadline: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        payableCurrency: v3LoanData.terms.payableCurrency,
        principal: NEW_TERMS_PRINCIPAL,
        collateralId: v3LoanData.terms.collateralId,
        affiliateCode: v3LoanData.terms.affiliateCode,
    };

    const sigProperties: SignatureProperties = {
        nonce: 1,
        maxUses: 1,
    };

    // lender signs a bid on v4
    const newLoanTermsSignature = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        newLoanTerms,
        newLender,
        "4",
        sigProperties,
        "l",
    );

    // new lender approves v4 origination controller to spend new loan terms principal (even though they do not have it yet)
    // if the new principal is greater than the v3 repayment amount, the new lender will owe the difference
    let lenderOwes: BigNumber = BigNumber.from(0);
    if (newLoanTerms.principal.sub(v3RepayAmount).gt(0)) {
        lenderOwes = newLoanTerms.principal.sub(v3RepayAmount);
        await payableCurrency.connect(whale).transfer(newLender.address, lenderOwes);
    }
    await payableCurrency.connect(newLender).approve(originationController.address, lenderOwes.add(newLoanTerms.principal));

    // borrower approves v4 borrower note
    await v3BorrowerNote.connect(borrower).approve(originationController.address, nextLoanId);

    // borrower approves difference of v3 repayment amount and new terms principal to be pulled by v4 origination controller
    let borrowerOwes: BigNumber = BigNumber.from(0);
    if (v3RepayAmount.sub(newLoanTerms.principal).gt(0)) {
        borrowerOwes = v3RepayAmount.sub(newLoanTerms.principal);
        await payableCurrency.connect(whale).transfer(borrower.address, borrowerOwes);
        await payableCurrency.connect(borrower).approve(originationController.address, borrowerOwes);
    }

    const borrowerBalanceBefore = await payableCurrency.balanceOf(BORROWER);
    console.log("Borrower balance before migration: ", ethers.utils.formatUnits(borrowerBalanceBefore, DECIMALS));
    const newlenderBalanceBefore = await payableCurrency.balanceOf(newLender.address);
    console.log("New lender balance before migration: ", ethers.utils.formatUnits(newlenderBalanceBefore, DECIMALS));
    const ocBalanceBefore = await payableCurrency.balanceOf(originationController.address);
    console.log("V4 OriginationController balance before migration: ", ethers.utils.formatUnits(ocBalanceBefore, DECIMALS));

    // borrower calls migrateV3Loan
    await originationController.connect(borrower).migrateV3Loan(
        nextLoanId,
        newLoanTerms,
        newLender.address,
        newLoanTermsSignature,
        sigProperties,
        []
    );
    console.log();
    console.log("✅ V3 loan migrated to V4!");
    console.log();

    // check the borrower and lender notes
    const v4Borrower = await borrowerNote.ownerOf(1);
    console.log("V4 Borrower: ", v4Borrower);
    const v4Lender = await lenderNote.ownerOf(1);
    console.log("V4 Lender: ", v4Lender);
    if (v4Lender !== newLender.address) {
        throw new Error("New V4 lender is not the same as new lender");
    }
    if (v4Borrower !== borrower.address) {
        throw new Error("New V4 borrower is not the same as borrower");
    }
    console.log();

    const borrowerBalanceAfter = await payableCurrency.balanceOf(BORROWER);
    console.log("Borrower balance after migration: ", ethers.utils.formatUnits(borrowerBalanceAfter, DECIMALS));
    const newlenderBalanceAfter = await payableCurrency.balanceOf(newLender.address);
    console.log("New Lender balance after migration: ", ethers.utils.formatUnits(newlenderBalanceAfter, DECIMALS));
    const ocBalanceAfter = await payableCurrency.balanceOf(originationController.address);
    console.log("V4 OriginationController balance after migration: ", ethers.utils.formatUnits(ocBalanceAfter, DECIMALS));

    console.log();
    console.log("Borrower net: ", ethers.utils.formatUnits(borrowerBalanceAfter.sub(borrowerBalanceBefore), DECIMALS));
    console.log("V3 lender net: ",  ethers.utils.formatUnits(newlenderBalanceAfter.sub(newlenderBalanceBefore), DECIMALS));

    console.log(SECTION_SEPARATOR);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
