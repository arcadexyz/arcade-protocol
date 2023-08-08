/* eslint no-unused-vars: 0 */
import "@nomiclabs/hardhat-ethers";
import hre, { ethers } from "hardhat";
import { BigNumber } from "ethers";

import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../utils/bootstrap-tools";
import {
    ERC20,
    PromissoryNote,
    BaseURIDescriptor,
    FeeController,
    LoanCore,
    RepaymentController,
    OriginationController,
    UnvaultedItemsVerifier,
    FlashRolloverNftfiToV3,
    CallWhitelistAllExtensions,
} from "../../typechain";
import { ORIGINATOR_ROLE, REPAYER_ROLE, BASE_URI } from "../utils/constants";
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
    MIN_LOAN_PRINCIPAL
} from "./config";

import { createLoanItemsSignature } from "../../test/utils/eip712";
import { ItemsPredicate, LoanTerms, SignatureItem } from "../../test/utils/types";
import { encodeSignatureItems } from "../../test/utils/loans";

/**
 * This script deploys V3 lending protocol and sets up roles and permissions. Deploys
 * the FlashRolloverNftFiToV3 contract, then, executes a NftFi -> V3 rollover using a
 * Balancer Flashloan to rollover an active NFTFI loan on mainnet. Before running this
 * script, make sure the nftfi-rollover/config.ts file is updated with valid values
 * from mainnet.
 *
 * This script defaults to using the ArcadeUnvaultedItemsVerifier for the rollover. The
 * verifier contract is set to an allowed verifier in the OriginationController.
 *
 * Run this script with the following command:
 * `FORK_MAINNET=true npx hardhat run scripts/nftfi-rollover/test-nftfi-rollover.ts`
 */

export async function main(): Promise<void> {
    // ================================== Deploy V3 Lending Protocol ==================================
    // Deploy V3 contracts
    console.log(SECTION_SEPARATOR);
    console.log("Deploying V3 contracts...");

    const DELEGATION_REGISTRY_ADDRESS = "0x00000000000076A84feF008CDAbe6409d2FE638B";

    const CallWhiteListFactory = await ethers.getContractFactory("CallWhitelistAllExtensions");
    const callWhitelistAllExtensions = <CallWhitelistAllExtensions>(
        await CallWhiteListFactory.deploy(DELEGATION_REGISTRY_ADDRESS)
    );
    await callWhitelistAllExtensions.deployed();
    console.log("CallWhitelistAllExtensions deployed to:", callWhitelistAllExtensions.address);
    console.log(SUBSECTION_SEPARATOR);

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
    const loanCore = <LoanCore>await LoanCoreFactory.deploy(borrowerNote.address, lenderNote.address);
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
    const originationController = <OriginationController>(
        await OriginationControllerFactory.deploy(loanCore.address, feeController.address)
    );
    await originationController.deployed();
    console.log("OriginationController deployed to:", originationController.address);
    console.log(SUBSECTION_SEPARATOR);

    const UnvaultedItemsVerifierFactory = await ethers.getContractFactory("UnvaultedItemsVerifier");
    const unvaultedItemsVerifier = <UnvaultedItemsVerifier>await UnvaultedItemsVerifierFactory.deploy();
    await unvaultedItemsVerifier.deployed();
    console.log("UnvaultedItemsVerifier deployed to:", unvaultedItemsVerifier.address);
    console.log(SUBSECTION_SEPARATOR);

    console.log("✅ Contracts Deployed\n");
    console.log(SECTION_SEPARATOR);

    // ================================== Setup V3 Lending Protocol ==================================
    console.log("Setting up V3 Lending Protocol...\n");

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

    // grant originationController the ORIGINATOR_ROLE
    const updateOriginationControllerRole = await loanCore.grantRole(ORIGINATOR_ROLE, ORIGINATION_CONTROLLER_ADDRESS);
    await updateOriginationControllerRole.wait();
    console.log(`LoanCore: originator role granted to ${ORIGINATION_CONTROLLER_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // grant repaymentController the REPAYER_ROLE
    const updateRepaymentControllerAdmin = await loanCore.grantRole(REPAYER_ROLE, REPAYMENT_CONTROLLER_ADDRESS);
    await updateRepaymentControllerAdmin.wait();
    console.log(`LoanCore: repayer role granted to ${REPAYMENT_CONTROLLER_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= OriginationController ==============

    // whitelist unvaultedItemsVerifier
    const setUnvaultedItemsVerifier = await originationController.setAllowedVerifiers(
        [unvaultedItemsVerifier.address],
        [true],
    );
    await setUnvaultedItemsVerifier.wait();
    console.log(
        `OriginationController added UnvaultedItemsVerifier, at address: ${unvaultedItemsVerifier.address} as allowed verifier`,
    );
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
    const addCollateral = await originationController.setAllowedCollateralAddresses(
        [LENDER_SPECIFIED_COLLATERAL],
        [true],
    );
    await addCollateral.wait();
    const addPayableCurrency = await originationController.setAllowedPayableCurrencies([PAYABLE_CURRENCY], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    await addPayableCurrency.wait();

    // Deploy NftFI -> v3 rollover contract and set the flash loan fee value
    console.log(SUBSECTION_SEPARATOR);
    console.log("Deploying rollover contract...");

    const contracts = {
        feeController: `${feeController.address}`,
        originationController: `${ORIGINATION_CONTROLLER_ADDRESS}`,
        loanCore: `${LOAN_CORE_ADDRESS}`,
        borrowerNote: `${borrowerNote.address}`,
    };

    const factory = await ethers.getContractFactory("FlashRolloverNftfiToV3");
    const flashRollover = <FlashRolloverNftfiToV3>await factory.deploy(BALANCER_ADDRESS, contracts);
    await flashRollover.deployed();
    console.log("FlashRolloverNftfiToV3 deployed to:", flashRollover.address);
    const flashLoanFee: BigNumber = BigNumber.from("0"); // 0% flash loan fee on Balancer
    console.log("Owner:", await flashRollover.owner());

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
    await payableCurrency.connect(newLender).approve(LOAN_CORE_ADDRESS, V3_LOAN_PRINCIPAL);
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
    await obligationReceiptToken.connect(borrower).approve(flashRollover.address, NFTFI_SMARTNFT_ID);
    console.log(SUBSECTION_SEPARATOR);

    // if new loan will not cover flash loan repayment, then borrower needs to cover the difference
    const flashLoanAmountDue = NFTFI_REPAYMENT_AMOUNT.add(NFTFI_REPAYMENT_AMOUNT.mul(flashLoanFee).div(10000));
    if (V3_LOAN_PRINCIPAL.lt(flashLoanAmountDue)) {
        const difference = flashLoanAmountDue.sub(V3_LOAN_PRINCIPAL);
        await payableCurrency.connect(whale).transfer(borrower.address, difference);
        await payableCurrency.connect(borrower).approve(flashRollover.address, difference);
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

    const signatureItems: SignatureItem[] = [
        {
            cType: 0, // ERC721
            asset: LENDER_SPECIFIED_COLLATERAL,
            tokenId: LENDER_SPECIFIED_COLLATERAL_ID,
            amount: 1,
            anyIdAllowed: false,
        },
    ];

    const predicates: ItemsPredicate[] = [
        {
            verifier: unvaultedItemsVerifier.address,
            data: encodeSignatureItems(signatureItems),
        },
    ];

    const sig = await createLoanItemsSignature(
        ORIGINATION_CONTROLLER_ADDRESS,
        "OriginationController",
        newLoanTerms,
        predicates,
        newLender,
        "3",
        NONCE.toString(),
        "l",
    );
    console.log(SUBSECTION_SEPARATOR);

    // ============= Execute ==============

    console.log("Execute NFTFI -> V3 rollover...");
    const tx = await flashRollover
        .connect(borrower)
        .rolloverNftfiLoan(LOAN_ID, newLoanTerms, newLender.address, NONCE, sig.v, sig.r, sig.s, predicates);

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
