/* eslint no-unused-vars: 0 */
import "@nomiclabs/hardhat-ethers";
import hre, { ethers } from "hardhat";
import { BigNumber } from "ethers";

import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../utils/bootstrap-tools";
import {
    ERC20,
    PromissoryNote,
    V2ToV3Rollover,
    BaseURIDescriptor,
    FeeController,
    LoanCore,
    RepaymentController,
    OriginationController,
} from "../../typechain";
import {
    ORIGINATOR_ROLE,
    REPAYER_ROLE,
    BASE_URI,
} from "../utils/constants";
import {
    BORROWER,
    PAYABLE_CURRENCY,
    WHALE,
    LOAN_COLLATERAL_ADDRESS,
    BALANCER_ADDRESS,
    V2_BORROWER_NOTE_ADDRESS,
    LOAN_ID,
    COLLATERAL_ID,
    V2_TOTAL_REPAYMENT_AMOUNT,
    NONCE,
    V3_LOAN_PRINCIPAL,
    V3_LOAN_INTEREST_RATE
} from "./config";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms } from "../../test/utils/types";

/**
 * This script deploys V3 lending protocol and sets up roles and permissions. Deploys
 * V2ToV3Rollover contract. Then, executes a V2 -> V3 rollover using an active loan
 * on mainnet. Before running this script, make sure the v2-migration/config.ts test
 * file is updated with valid values from mainnet.
 *
 * Run this script with the following command:
 * `FORK_MAINNET=true npx hardhat run scripts/v2-migration/test-v2-v3-rollover.ts`
 */
export async function main(): Promise<void> {
    // ================================== Deploy V3 Lending Protocol ==================================
    // Deploy V3 contracts
    console.log(SECTION_SEPARATOR);
    console.log("Deploying V3 contracts...\n");

    const BaseURIDescriptorFactory = await ethers.getContractFactory("BaseURIDescriptor");
    const baseURIDescriptor = <BaseURIDescriptor>await BaseURIDescriptorFactory.deploy(`${BASE_URI}`);
    await baseURIDescriptor.deployed();
    console.log("BaseURIDescriptor deployed to:", baseURIDescriptor.address);
    console.log(SUBSECTION_SEPARATOR);

    const FeeControllerFactory = await ethers.getContractFactory("FeeController");
    const feeController = <FeeController>await FeeControllerFactory.deploy();
    await feeController.deployed();
    console.log("FeeController deployed to: ", feeController.address);
    console.log(SUBSECTION_SEPARATOR);

    const bNoteName = "Arcade.xyz BorrowerNote";
    const bNoteSymbol = "aBN";
    const PromissoryNoteFactory = await ethers.getContractFactory("PromissoryNote");
    const borrowerNote = <PromissoryNote>(
        await PromissoryNoteFactory.deploy(bNoteName, bNoteSymbol, baseURIDescriptor.address)
    );
    await borrowerNote.deployed();
    console.log("BorrowerNote deployed to:", borrowerNote.address);
    console.log(SUBSECTION_SEPARATOR);

    const lNoteName = "Arcade.xyz LenderNote";
    const lNoteSymbol = "aLN";
    const lenderNote = <PromissoryNote>(
        await PromissoryNoteFactory.deploy(lNoteName, lNoteSymbol, baseURIDescriptor.address)
    );
    await lenderNote.deployed();
    console.log("LenderNote deployed to:", lenderNote.address);
    console.log(SUBSECTION_SEPARATOR);

    const LoanCoreFactory = await ethers.getContractFactory("LoanCore");
    const loanCore = <LoanCore>await LoanCoreFactory.deploy(
        borrowerNote.address,
        lenderNote.address
    );
    await loanCore.deployed();
    console.log("LoanCore deployed to:", loanCore.address);
    console.log(SUBSECTION_SEPARATOR);

    const RepaymentControllerFactory = await ethers.getContractFactory("RepaymentController");
    const repaymentController = <RepaymentController>(
        await RepaymentControllerFactory.deploy(loanCore.address, feeController.address)
    );
    await repaymentController.deployed();
    console.log("RepaymentController deployed to:", repaymentController.address);
    console.log(SUBSECTION_SEPARATOR);

    const OriginationControllerFactory = await ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>await OriginationControllerFactory.deploy(
        loanCore.address,
        feeController.address
    );
    await originationController.deployed();
    console.log("OriginationController deployed to:", originationController.address);
    console.log(SUBSECTION_SEPARATOR);

    console.log("✅ Contracts Deployed\n");
    console.log(SECTION_SEPARATOR);

    // ================================== Setup V3 Lending Protocol ==================================

    console.log("Setting up V3 Lending Protocol...\n")

    // roles addresses
    const ADMIN_ADDRESS = process.env.ADMIN ? process.env.ADMIN : (await hre.ethers.getSigners())[0].address;
    console.log("Admin address:", ADMIN_ADDRESS);
    console.log(SUBSECTION_SEPARATOR);

    const ORIGINATION_CONTROLLER_ADDRESS = originationController.address;
    const LOAN_CORE_ADDRESS = loanCore.address;
    const REPAYMENT_CONTROLLER_ADDRESS = repaymentController.address;

    // ============= BorrowerNote ==============

    const initBorrowerNote = await borrowerNote.initialize(LOAN_CORE_ADDRESS);
    await initBorrowerNote.wait();
    console.log(`BorrowerNote: initialized loanCore at address ${LOAN_CORE_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= LenderNote ==============

    const initLenderNote = await lenderNote.initialize(LOAN_CORE_ADDRESS);
    await initLenderNote.wait();
    console.log(`LenderNote: initialized loanCore at address ${LOAN_CORE_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= LoanCore ==============

    // grant OriginationController the ORIGINATOR_ROLE
    const updateOriginationControllerRole = await loanCore.grantRole(ORIGINATOR_ROLE, ORIGINATION_CONTROLLER_ADDRESS);
    await updateOriginationControllerRole.wait();
    console.log(`LoanCore: originator role granted to ${ORIGINATION_CONTROLLER_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // grant RepaymentController the REPAYER_ROLE
    const updateRepaymentControllerAdmin = await loanCore.grantRole(REPAYER_ROLE, REPAYMENT_CONTROLLER_ADDRESS);
    await updateRepaymentControllerAdmin.wait();
    console.log(`LoanCore: repayer role granted to ${REPAYMENT_CONTROLLER_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    console.log("✅ V3 Lending Protocol setup complete\n");
    console.log(SECTION_SEPARATOR);

    // ================================== Execute V2 -> V3 Rollover ==================================

    console.log("Perform V2 -> V3 rollover...\n");

    // ============= Setup ==============
    // use accounts[0] as new lender
    const [newLender] = await hre.ethers.getSigners();
    console.log("New lender address:", newLender.address);

    // Whitelist collateral and payable currency used in the new loan terms
    console.log(SUBSECTION_SEPARATOR);
    console.log(`Add collateral and payable currency to V3 OriginationController...`);
    const addCollateral = await originationController.setAllowedCollateralAddresses([LOAN_COLLATERAL_ADDRESS], [true]);
    await addCollateral.wait();
    const addPayableCurrency = await originationController.setAllowedPayableCurrencies([PAYABLE_CURRENCY], [true]);
    await addPayableCurrency.wait();

    // Deploy v2 -> v3 rollover contract
    console.log(SUBSECTION_SEPARATOR);
    const contracts = {
        feeControllerV3: feeController.address,
        originationControllerV3: originationController.address,
        loanCoreV3: loanCore.address,
        borrowerNoteV3: borrowerNote.address,
    };
    const factory = await ethers.getContractFactory("V2ToV3Rollover")
    const flashRollover = <V2ToV3Rollover>await factory.deploy(BALANCER_ADDRESS, contracts);
    await flashRollover.deployed();
    console.log("V2ToV3Rollover deployed to:", flashRollover.address);
    const flashLoanFee: BigNumber = BigNumber.from("0"); // 0% flash loan fee on Balancer

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
    const payableCurrency = <ERC20>erc20Factory.attach(PAYABLE_CURRENCY);

    const erc721Factory = await ethers.getContractFactory("ERC721");
    const bNoteV2 = <PromissoryNote>erc721Factory.attach(V2_BORROWER_NOTE_ADDRESS);

    // Distribute ETH and payable currency by impersonating a whale account
    console.log("Whale distributes ETH and payable currency...");
    await whale.sendTransaction({ to: borrower.address, value: ethers.utils.parseEther("10") });
    await whale.sendTransaction({ to: newLender.address, value: ethers.utils.parseEther("10") });
    await payableCurrency.connect(whale).transfer(newLender.address, V3_LOAN_PRINCIPAL)

    console.log(SUBSECTION_SEPARATOR);
    console.log("New lender approves payable currency to V3 LoanCore...");
    await payableCurrency.connect(newLender).approve(LOAN_CORE_ADDRESS, V3_LOAN_PRINCIPAL);

    console.log(SUBSECTION_SEPARATOR);
    console.log("Borrower approves V2 BorrowerNote to rollover contract...");
    await bNoteV2.connect(borrower).approve(flashRollover.address, LOAN_ID);

    // if new loan will not cover flash loan repayment, then borrower needs to cover the difference
    const flashLoanAmountDue = V2_TOTAL_REPAYMENT_AMOUNT.add(V2_TOTAL_REPAYMENT_AMOUNT.mul(flashLoanFee).div(10000));
    if (V3_LOAN_PRINCIPAL.lt(flashLoanAmountDue)) {
        const difference = flashLoanAmountDue.sub(V3_LOAN_PRINCIPAL);
        await payableCurrency.connect(whale).transfer(borrower.address, difference)
        await payableCurrency.connect(borrower).approve(flashRollover.address, difference);
    }
    console.log(SUBSECTION_SEPARATOR);

    console.log("New Lender creates V3 signature...");
    const newLoanTerms: LoanTerms = {
        durationSecs: 86400,
        deadline: Math.floor(Date.now() / 1000) + 100_000,
        proratedInterestRate: V3_LOAN_INTEREST_RATE,
        principal: V3_LOAN_PRINCIPAL,
        collateralAddress: LOAN_COLLATERAL_ADDRESS,
        collateralId: COLLATERAL_ID,
        payableCurrency: PAYABLE_CURRENCY,
        affiliateCode: ethers.constants.HashZero
    };

    const sig = await createLoanTermsSignature(
        ORIGINATION_CONTROLLER_ADDRESS,
        "OriginationController",
        newLoanTerms,
        newLender,
        "3",
        NONCE,
        "l",
    );
    console.log(SUBSECTION_SEPARATOR);

    // ============= Execute ==============

    console.log("Execute V2 -> V3 rollover...\n");
    const tx = await flashRollover.connect(borrower).rolloverLoan(
        LOAN_ID,
        newLoanTerms,
        newLender.address,
        NONCE,
        sig.v,
        sig.r,
        sig.s,
    );       

    // send transaction
    console.log("✅ Transaction hash:", tx.hash);

    console.log(SECTION_SEPARATOR);
    console.log("Rollover successful 🎉\n");
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