/* eslint no-unused-vars: 0 */
import "@nomiclabs/hardhat-ethers";
import hre, { ethers } from "hardhat";
import { BigNumber } from "ethers";

import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "./utils/bootstrap-tools";
import {
    ERC20,
    PromissoryNote,
    V2ToV3BalancerRollover,
    V2ToV3AAVERollover,
    CallWhitelist,
    BaseURIDescriptor,
    FeeController,
    LoanCore,
    RepaymentController,
    OriginationController,
    ArcadeItemsVerifier,
    PunksVerifier,
    CollectionWideOfferVerifier,
    ArtBlocksVerifier,
    UnvaultedItemsVerifier,
    CallWhitelistApprovals,
    DelegationRegistry,
    CallWhitelistDelegation,
} from "../typechain";
import {
    ADMIN_ROLE,
    FEE_CLAIMER_ROLE,
    ORIGINATOR_ROLE,
    REPAYER_ROLE,
    WHITELIST_MANAGER_ROLE,
    BASE_URI,
    PUNKS_ADDRESS,
} from "./utils/constants";

import { createLoanTermsSignature } from "../test/utils/eip712";
import { LoanTerms } from "../test/utils/types";

/**
 * This script deploys V3 lending protocol and sets up roles and permissions. Deploys
 * V2ToV3BalancerRollover contract. Then, executes a V2 -> V3 rollover using active
 * loan on mainnet. Before running this script, make sure the MAINNET STATE FOR FORKING
 * section is updated with the valid values from mainnet. Also ensure that the collateral
 * and payable currency used in the loan terms are added to the OriginationController in
 * the setup section. Lastly, choose which flash loan provider to use by setting the
 * FLASH_SOURCE env variable to either 'balancer' or 'AAVE'.
 *
 * Run this script with the following command:
 * `FORK_MAINNET=true npx hardhat run scripts/test-v2-v3-rollover.ts`
 */
export async function main(): Promise<void> {
    // check the flash loan provider is set
    let flashSource: string;
    if (!process.env.FLASH_SOURCE) {
        throw new Error("FLASH_SOURCE env variable not set");
    } else {
        flashSource = process.env.FLASH_SOURCE;
    }

    // ================================== Deploy V3 Lending Protocol ==================================
    // Deploy V3 contracts
    console.log(SECTION_SEPARATOR);
    console.log("Deploying V3 contracts...");

    const CallWhiteListFactory = await ethers.getContractFactory("CallWhitelist");
    const whitelist = <CallWhitelist>await CallWhiteListFactory.deploy();
    await whitelist.deployed();
    console.log("CallWhitelist deployed to:", whitelist.address);
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

    const VerifierFactory = await ethers.getContractFactory("ArcadeItemsVerifier");
    const verifier = <ArcadeItemsVerifier>await VerifierFactory.deploy();
    await verifier.deployed();
    console.log("ItemsVerifier deployed to:", verifier.address);
    console.log(SUBSECTION_SEPARATOR);

    const PunksVerifierFactory = await ethers.getContractFactory("PunksVerifier");
    const punksVerifier = <PunksVerifier>await PunksVerifierFactory.deploy(PUNKS_ADDRESS);
    await punksVerifier.deployed();
    console.log("PunksVerifier deployed to:", punksVerifier.address);
    console.log(SUBSECTION_SEPARATOR);

    const CWOVerifierFactory = await ethers.getContractFactory("CollectionWideOfferVerifier");
    const collectionWideOfferVerifier = <CollectionWideOfferVerifier>await CWOVerifierFactory.deploy();
    await collectionWideOfferVerifier.deployed();
    console.log("CollectionWideVerifier deployed to:", collectionWideOfferVerifier.address);
    console.log(SUBSECTION_SEPARATOR);

    const ArtBlocksVerifierFactory = await ethers.getContractFactory("ArtBlocksVerifier");
    const artBlocksVerifier = <ArtBlocksVerifier>await ArtBlocksVerifierFactory.deploy();
    await artBlocksVerifier.deployed();
    console.log("ArtBlocksVerifier deployed to:", artBlocksVerifier.address);
    console.log(SUBSECTION_SEPARATOR);

    const UnvaultedItemsVerifierFactory = await ethers.getContractFactory("UnvaultedItemsVerifier");
    const unvaultedItemsVerifier = <UnvaultedItemsVerifier>await UnvaultedItemsVerifierFactory.deploy();
    await unvaultedItemsVerifier.deployed();
    console.log("UnvaultedItemsVerifier deployed to:", unvaultedItemsVerifier.address);
    console.log(SUBSECTION_SEPARATOR);

    const CallWhitelistApprovalsFactory = await ethers.getContractFactory("CallWhitelistApprovals");
    const callWhitelistApprovals = <CallWhitelistApprovals>await CallWhitelistApprovalsFactory.deploy();
    await callWhitelistApprovals.deployed();
    console.log("CallWhitelistApprovals deployed to:", callWhitelistApprovals.address);
    console.log(SUBSECTION_SEPARATOR);

    const DelegationRegistryFactory = await ethers.getContractFactory("DelegationRegistry");
    const delegationRegistry = <DelegationRegistry>await DelegationRegistryFactory.deploy();
    await delegationRegistry.deployed();
    console.log("DelegationRegistry deployed to:", delegationRegistry.address);
    console.log(SUBSECTION_SEPARATOR);

    const CallWhitelistDelegationFactory = await ethers.getContractFactory("CallWhitelistDelegation");
    const callWhitelistDelegation = <CallWhitelistDelegation>(
        await CallWhitelistDelegationFactory.deploy(delegationRegistry.address)
    );
    await callWhitelistDelegation.deployed();
    console.log("CallWhitelistDelegation deployed to:", callWhitelistDelegation.address);
    console.log(SUBSECTION_SEPARATOR);

    console.log(SECTION_SEPARATOR);
    console.log("Contracts Deployed, Setting up V3...");

    // ================================== Setup V3 Lending Protocol ==================================

    // roles addresses
    const ADMIN_ADDRESS = process.env.ADMIN ? process.env.ADMIN : (await hre.ethers.getSigners())[0].address;
    console.log("Admin address:", ADMIN_ADDRESS);

    const ORIGINATION_CONTROLLER_ADDRESS = originationController.address;
    const LOAN_CORE_ADDRESS = loanCore.address;
    const REPAYMENT_CONTROLLER_ADDRESS = repaymentController.address;

    console.log(SECTION_SEPARATOR);

    // ============= CallWhitelist ==============

    // set CallWhiteList admin
    const updateWhitelistAdmin = await whitelist.transferOwnership(ADMIN_ADDRESS);
    await updateWhitelistAdmin.wait();
    console.log(`CallWhitelist: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= CallWhitelistApprovals ==============

    // set CallWhiteListApprovals admin
    const updateWhitelistApprovalsAdmin = await callWhitelistApprovals.transferOwnership(ADMIN_ADDRESS);
    await updateWhitelistApprovalsAdmin.wait();
    console.log(`CallWhitelistApprovals: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= CallWhitelistDelegation ==============

    // set CallWhiteListDelegation admin
    const updateWhitelistDelegationAdmin = await callWhitelistDelegation.transferOwnership(ADMIN_ADDRESS);
    await updateWhitelistDelegationAdmin.wait();
    console.log(`CallWhitelistDelegation: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== BaseURIDescriptor ============

    // set BaseURIDescriptorAdmin admin
    const updateBaseURIDescriptorAdmin = await baseURIDescriptor.transferOwnership(ADMIN_ADDRESS);
    await updateBaseURIDescriptorAdmin.wait();
    console.log(`BaseURIDescriptor: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= FeeController ==============

    // set FeeController admin
    const updateFeeControllerAdmin = await feeController.transferOwnership(ADMIN_ADDRESS);
    await updateFeeControllerAdmin.wait();
    console.log(`FeeController: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

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

    // grant the admin role for LoanCore
    const updateLoanCoreAdmin = await loanCore.grantRole(ADMIN_ROLE, ADMIN_ADDRESS);
    await updateLoanCoreAdmin.wait();
    console.log(`LoanCore: admin role granted to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // grant LoanCore admin fee claimer permissions
    const updateLoanCoreFeeClaimer = await loanCore.grantRole(FEE_CLAIMER_ROLE, ADMIN_ADDRESS);
    await updateLoanCoreFeeClaimer.wait();
    console.log(`LoanCore: fee claimer role granted to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // grant originationContoller the originator role
    const updateOriginationControllerRole = await loanCore.grantRole(ORIGINATOR_ROLE, ORIGINATION_CONTROLLER_ADDRESS);
    await updateOriginationControllerRole.wait();
    console.log(`LoanCore: originator role granted to ${ORIGINATION_CONTROLLER_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // grant repaymentContoller the REPAYER_ROLE
    const updateRepaymentControllerAdmin = await loanCore.grantRole(REPAYER_ROLE, REPAYMENT_CONTROLLER_ADDRESS);
    await updateRepaymentControllerAdmin.wait();
    console.log(`LoanCore: repayer role granted to ${REPAYMENT_CONTROLLER_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= OriginationController ==============

    // whitelist verifiers
    const setWhitelistVerifier = await originationController.setAllowedVerifiers([verifier.address], [true]);
    await setWhitelistVerifier.wait();
    console.log(`OriginationController added ArcadeItemsVerifier, at address: ${verifier.address} as allowed verifier`);
    console.log(SUBSECTION_SEPARATOR);

    const setPunksVerifier = await originationController.setAllowedVerifiers([punksVerifier.address], [true]);
    await setPunksVerifier.wait();
    console.log(`OriginationController added PunksVerifier, at address: ${punksVerifier.address} as allowed verifier`);
    console.log(SUBSECTION_SEPARATOR);

    const setcollectionWideOfferVerifier = await originationController.setAllowedVerifiers(
        [collectionWideOfferVerifier.address],
        [true],
    );
    await setcollectionWideOfferVerifier.wait();
    console.log(`OriginationController added CollectionWideOfferVerifier at address: ${collectionWideOfferVerifier.address} as allowed verifier`);
    console.log(SUBSECTION_SEPARATOR);

    const setArtBlocksVerifier = await originationController.setAllowedVerifiers([artBlocksVerifier.address], [true]);
    await setArtBlocksVerifier.wait();
    console.log(`OriginationController added ArtBlocksVerifier, at address ${artBlocksVerifier.address} as allowed verifier`);
    console.log(SUBSECTION_SEPARATOR);

    const setUnvaultedItemsVerifier = await originationController.setAllowedVerifiers(
        [unvaultedItemsVerifier.address],
        [true],
    );
    await setUnvaultedItemsVerifier.wait();
    console.log(
        `OriginationController added UnvaultedItemsVerifier, at address: ${unvaultedItemsVerifier.address} as allowed verifier`,
    );
    console.log(SUBSECTION_SEPARATOR);

    // grant originationController the owner role
    const updateOriginationControllerAdmin = await originationController.grantRole(ADMIN_ROLE, ADMIN_ADDRESS);
    await updateOriginationControllerAdmin.wait();

    // grant originationController the owner role
    const updateOriginationWhiteListManager = await originationController.grantRole(
        WHITELIST_MANAGER_ROLE,
        ADMIN_ADDRESS,
    );
    await updateOriginationWhiteListManager.wait();

    console.log(`OriginationController: admin role granted to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    console.log("V3 Lending Protocol setup complete");
    console.log(SECTION_SEPARATOR);

    // ================================== Execute V2 -> V3 Rollover ==================================

    // ======= Mainnet state for forking =======

    ///////////////////////////////
    // MAINNET STATE FOR FORKING //
    ///////////////////////////////
    const BORROWER = "0xa390baf0840b52aa57e97cd06c69459bea974947";
    const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
    const WHALE = "0x1Cb17a66DC606a52785f69F08F4256526aBd4943";
    const LOAN_COLLATERAL_ADDRESS = "0x6e9b4c2f6bd57b7b924d29b5dcfca1273ecc94a2"; // Vault Factory
    const ADDRESSES_PROVIDER_ADDRESS = "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5"; // AAVE
    const BALANCER_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer
    const BORROWER_NOTE_ADDRESS = "0x337104A4f06260Ff327d6734C555A0f5d8F863aa";
    const SOURCE_LOAN_CORE_ADDRESS = "0x81b2F8Fc75Bab64A6b144aa6d2fAa127B4Fa7fD9"; // v2 Loan Core mainnet
    const SOURCE_REPAYMENT_CONTROLLER_ADDRESS = "0xb39dAB85FA05C381767FF992cCDE4c94619993d4"; // v2 Repayment Controller mainnet

    ///////////////////////////////
    //////// V2 LOAN DATA /////////
    ///////////////////////////////
    const LOAN_ID = 2193; // active loanId on mainnet
    const COLLATERAL_ID = BigNumber.from("163815819589138376285603138916992491026957408231"); // vault id on mainnet

    ///////////////////////////////
    //////// V3 LOAN DATA /////////
    ///////////////////////////////
    const NONCE = 1; // Nonce to use in new lender's bid
    const newLoanAmount = ethers.utils.parseUnits("13000.00", 18); // no fees
    const newLoanInterestRate = ethers.utils.parseUnits("3.75", 18); // 2.67% interest
    const oldLoanRepaymentAmount = ethers.utils.parseUnits("25679", 18); // no fees
    const [newLender] = await hre.ethers.getSigners();
    console.log("New lender address:", newLender.address);

    // ============= Setup ==============

    // Whitelist collateral and payable currency used in the new loan terms
    console.log(SUBSECTION_SEPARATOR);
    console.log(`Add collateral and payable currency to V3 OriginationController...`);
    const addCollateral = await originationController.setAllowedCollateralAddresses([LOAN_COLLATERAL_ADDRESS], [true]);
    await addCollateral.wait();
    const addPayableCurrency = await originationController.setAllowedPayableCurrencies([DAI_ADDRESS], [true]);
    await addPayableCurrency.wait();

    // Deploy v2 -> v3 rollover contract and set the flash loan fee value
    console.log(SUBSECTION_SEPARATOR);
    console.log("Deploying rollover contract...");
    let flashRollover: V2ToV3BalancerRollover | V2ToV3AAVERollover;
    let flashLoanFee: BigNumber;
    if (flashSource === "balancer") {
        const factory = await ethers.getContractFactory("V2ToV3BalancerRollover")
        flashRollover = <V2ToV3BalancerRollover>await factory.deploy(BALANCER_ADDRESS);
        await flashRollover.deployed();
        console.log("V2ToV3BalancerRollover deployed to:", flashRollover.address);

        flashLoanFee = BigNumber.from("0");
    } else if (flashSource === "AAVE") {
        const factory = await ethers.getContractFactory("V2ToV3AAVERollover")
        flashRollover = <V2ToV3AAVERollover>await factory.deploy(ADDRESSES_PROVIDER_ADDRESS);
        await flashRollover.deployed();
        console.log("V2ToV3AAVERollover deployed to:", flashRollover.address);

        flashLoanFee = BigNumber.from("9");
    } else {
        throw new Error("Invalid flash loan provider, please use 'balancer' or 'AAVE'");
    }

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
    const payableCurrency = <ERC20>erc20Factory.attach(DAI_ADDRESS);

    const erc721Factory = await ethers.getContractFactory("ERC721");
    const bNoteV2 = <PromissoryNote>erc721Factory.attach(BORROWER_NOTE_ADDRESS);

    // Distribute WETH by impersonating a large account
    console.log("Whale distributes ETH and WETH...");
    await whale.sendTransaction({ to: borrower.address, value: ethers.utils.parseEther("10") });
    await whale.sendTransaction({ to: newLender.address, value: ethers.utils.parseEther("10") });
    await payableCurrency.connect(whale).transfer(newLender.address, newLoanAmount)

    console.log(SUBSECTION_SEPARATOR);
    console.log("New lender approves WETH to V3 LoanCore...");
    await payableCurrency.connect(newLender).approve(LOAN_CORE_ADDRESS, newLoanAmount);

    console.log(SUBSECTION_SEPARATOR);
    console.log("Borrower approves V2 borrowerNote to rollover contract...");
    await bNoteV2.connect(borrower).approve(flashRollover.address, LOAN_ID);

    // if new loan will not cover flash loan repayment, then borrower needs to cover the difference
    const flashLoanAmountDue = oldLoanRepaymentAmount.add(oldLoanRepaymentAmount.mul(flashLoanFee).div(10000));
    if (newLoanAmount.lt(flashLoanAmountDue)) {
        const difference = flashLoanAmountDue.sub(newLoanAmount);
        await payableCurrency.connect(whale).transfer(borrower.address, difference)
        await payableCurrency.connect(borrower).approve(flashRollover.address, difference);
    }
    console.log(SUBSECTION_SEPARATOR);

    console.log("New Lender creates V3 signature...");
    const newLoanTerms: LoanTerms = {
        durationSecs: 86400,
        deadline: Math.floor(Date.now() / 1000) + 100_000,
        proratedInterestRate: newLoanInterestRate,
        principal: newLoanAmount, // V3 loan, principal
        collateralAddress: LOAN_COLLATERAL_ADDRESS,
        collateralId: COLLATERAL_ID,
        payableCurrency: DAI_ADDRESS,
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

    console.log("Execute V2 -> V3 rollover...");
    const contracts = {
        sourceLoanCore: SOURCE_LOAN_CORE_ADDRESS,
        targetLoanCore: LOAN_CORE_ADDRESS,
        sourceRepaymentController: SOURCE_REPAYMENT_CONTROLLER_ADDRESS,
        targetOriginationController: ORIGINATION_CONTROLLER_ADDRESS,
        collateral: LOAN_COLLATERAL_ADDRESS
    };

    // encode rollover
    const tx = await flashRollover.connect(borrower).rolloverLoan(
        contracts,
        LOAN_ID,
        newLoanTerms,
        newLender.address,
        NONCE,
        sig.v,
        sig.r,
        sig.s,
    );       

    // send transaction
    console.log("Transaction hash:", tx.hash);

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