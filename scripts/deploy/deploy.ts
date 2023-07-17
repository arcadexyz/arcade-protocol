import { ethers } from "hardhat";

import { writeJson } from "./write-json";
import { BASE_URI, SECTION_SEPARATOR, SUBSECTION_SEPARATOR, PUNKS_ADDRESS } from "../utils/constants";

import {
    AssetVault,
    FeeController,
    LoanCore,
    PromissoryNote,
    RepaymentController,
    OriginationController,
    CallWhitelist,
    ArcadeItemsVerifier,
    VaultFactory,
    BaseURIDescriptor,
    PunksVerifier,
    CollectionWideOfferVerifier,
    ArtBlocksVerifier,
    UnvaultedItemsVerifier,
    CallWhitelistApprovals,
    CallWhitelistDelegation,
    DelegationRegistry
} from "../../typechain";

export interface DeployedResources {
    assetVault: AssetVault;
    feeController: FeeController;
    loanCore: LoanCore;
    borrowerNote: PromissoryNote;
    lenderNote: PromissoryNote;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    whitelist: CallWhitelist;
    vaultFactory: VaultFactory;
    verifier: ArcadeItemsVerifier;
    baseURIDescriptor: BaseURIDescriptor;
    punksVerifier: PunksVerifier;
    collectionWideOfferVerifier: CollectionWideOfferVerifier;
    artBlocksVerifier: ArtBlocksVerifier;
    unvaultedItemsVerifier: UnvaultedItemsVerifier;
    callWhitelistApprovals: CallWhitelistApprovals,
    callWhitelistDelegation: CallWhitelistDelegation;
    delegationRegistry: DelegationRegistry;
}

export async function main(): Promise<DeployedResources> {
    // Hardhat always runs the compile task when running scripts through it.
    // If this runs in a standalone fashion you may want to call compile manually
    // to make sure everything is compiled
    // await run("compile");

    console.log(SECTION_SEPARATOR);

    const CallWhiteListFactory = await ethers.getContractFactory("CallWhitelist");
    const whitelist = <CallWhitelist>await CallWhiteListFactory.deploy();
    await whitelist.deployed();

    const whitelistAddress = whitelist.address;
    console.log("CallWhitelist deployed to:", whitelistAddress);
    console.log(SUBSECTION_SEPARATOR);

    const BaseURIDescriptorFactory = await ethers.getContractFactory("BaseURIDescriptor");
    const baseURIDescriptor = <BaseURIDescriptor>await BaseURIDescriptorFactory.deploy(`${BASE_URI}`);
    await baseURIDescriptor.deployed();

    const baseURIDescriptorAddress = baseURIDescriptor.address;
    console.log("BaseURIDescriptor deployed to:", baseURIDescriptorAddress);
    console.log(SUBSECTION_SEPARATOR);

    const FeeControllerFactory = await ethers.getContractFactory("FeeController");
    const feeController = <FeeController>await FeeControllerFactory.deploy();
    await feeController.deployed();

    const feeControllerAddress = feeController.address;
    console.log("FeeController deployed to: ", feeControllerAddress);
    console.log(SUBSECTION_SEPARATOR);

    const AssetVaultFactory = await ethers.getContractFactory("AssetVault");
    const assetVault = <AssetVault>await AssetVaultFactory.deploy();
    await assetVault.deployed();

    const assetVaultAddress = assetVault.address;
    console.log("AssetVault deployed to:", assetVaultAddress);
    console.log(SUBSECTION_SEPARATOR);

    const VaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
    const vaultFactory = <VaultFactory>(
        await VaultFactoryFactory.deploy(
            assetVault.address,
            whitelist.address,
            feeController.address,
            baseURIDescriptor.address,
        )
    );
    await vaultFactory.deployed();

    const vaultFactoryAddress = vaultFactory.address;
    console.log("VaultFactory deployed to:", vaultFactoryAddress);
    console.log(SUBSECTION_SEPARATOR);

    const bNoteName = "Arcade.xyz BorrowerNote";
    const bNoteSymbol = "aBN";
    const PromissoryNoteFactory = await ethers.getContractFactory("PromissoryNote");
    const borrowerNote = <PromissoryNote>(
        await PromissoryNoteFactory.deploy(bNoteName, bNoteSymbol, baseURIDescriptor.address)
    );
    await borrowerNote.deployed();

    const borrowerNoteAddress = borrowerNote.address;
    console.log("BorrowerNote deployed to:", borrowerNote.address);

    const lNoteName = "Arcade.xyz LenderNote";
    const lNoteSymbol = "aLN";
    const lenderNote = <PromissoryNote>(
        await PromissoryNoteFactory.deploy(lNoteName, lNoteSymbol, baseURIDescriptor.address)
    );
    await lenderNote.deployed();

    const lenderNoteAddress = lenderNote.address;
    console.log("LenderNote deployed to:", lenderNoteAddress);
    console.log(SUBSECTION_SEPARATOR);

    const LoanCoreFactory = await ethers.getContractFactory("LoanCore");
    const loanCore = <LoanCore>await LoanCoreFactory.deploy(
        borrowerNote.address,
        lenderNote.address
    );
    await loanCore.deployed();

    const loanCoreAddress = loanCore.address;
    console.log("LoanCore deployed to:", loanCoreAddress);
    console.log(SUBSECTION_SEPARATOR);

    const RepaymentControllerFactory = await ethers.getContractFactory("RepaymentController");
    const repaymentController = <RepaymentController>(
        await RepaymentControllerFactory.deploy(loanCore.address, feeController.address)
    );
    await repaymentController.deployed();

    const repaymentContAddress = repaymentController.address;
    console.log("RepaymentController deployed to:", repaymentContAddress);

    console.log(SUBSECTION_SEPARATOR);

    const OriginationControllerFactory = await ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>await OriginationControllerFactory.deploy(
        loanCore.address,
        feeController.address
    );
    await originationController.deployed();

    const originationContAddress = originationController.address;
    console.log("OriginationController deployed to:", originationContAddress);

    console.log(SUBSECTION_SEPARATOR);

    const VerifierFactory = await ethers.getContractFactory("ArcadeItemsVerifier");
    const verifier = <ArcadeItemsVerifier>await VerifierFactory.deploy();
    await verifier.deployed();

    const verifierAddress = verifier.address;
    console.log("ItemsVerifier deployed to:", verifierAddress);
    console.log(SUBSECTION_SEPARATOR);

    const PunksVerifierFactory = await ethers.getContractFactory("PunksVerifier");
    const punksVerifier = <PunksVerifier>await PunksVerifierFactory.deploy(PUNKS_ADDRESS);
    await punksVerifier.deployed();

    const punksVerifierAddress = punksVerifier.address;
    console.log("PunksVerifier deployed to:", punksVerifierAddress);
    console.log(SUBSECTION_SEPARATOR);

    const CWOVerifierFactory = await ethers.getContractFactory("CollectionWideOfferVerifier");
    const collectionWideOfferVerifier = <CollectionWideOfferVerifier>await CWOVerifierFactory.deploy();
    await collectionWideOfferVerifier.deployed();

    const collectionWideOfferVerifierAddress = collectionWideOfferVerifier.address;
    console.log("CollectionWideVerifier deployed to:", collectionWideOfferVerifierAddress);
    console.log(SUBSECTION_SEPARATOR);

    const ArtBlocksVerifierFactory = await ethers.getContractFactory("ArtBlocksVerifier");
    const artBlocksVerifier = <ArtBlocksVerifier>await ArtBlocksVerifierFactory.deploy();
    await artBlocksVerifier.deployed();

    const artBlocksVerifierAddress = artBlocksVerifier.address;
    console.log("ArtBlocksVerifier deployed to:", artBlocksVerifierAddress);
    console.log(SUBSECTION_SEPARATOR);

    const UnvaultedItemsVerifierFactory = await ethers.getContractFactory("UnvaultedItemsVerifier");
    const unvaultedItemsVerifier = <UnvaultedItemsVerifier>await UnvaultedItemsVerifierFactory.deploy();
    await unvaultedItemsVerifier.deployed();

    const unvaultedItemsVerifierAddress = unvaultedItemsVerifier.address;
    console.log("UnvaultedItemsVerifier deployed to:", unvaultedItemsVerifierAddress);
    console.log(SUBSECTION_SEPARATOR);

    const CallWhitelistApprovalsFactory = await ethers.getContractFactory("CallWhitelistApprovals");
    const callWhitelistApprovals = <CallWhitelistApprovals>await CallWhitelistApprovalsFactory.deploy();
    await callWhitelistApprovals.deployed();

    const callWhitelistApprovalsAddress = callWhitelistApprovals.address;
    console.log("CallWhitelistApprovals deployed to:", callWhitelistApprovalsAddress);
    console.log(SUBSECTION_SEPARATOR);

    const DelegationRegistryFactory = await ethers.getContractFactory("DelegationRegistry");
    const delegationRegistry = <DelegationRegistry>await DelegationRegistryFactory.deploy();
    await delegationRegistry.deployed();

    const delegationRegistryAddress = delegationRegistry.address;
    console.log("DelegationRegistry deployed to:", delegationRegistryAddress);
    console.log(SUBSECTION_SEPARATOR);

    const CallWhitelistDelegationFactory = await ethers.getContractFactory("CallWhitelistDelegation");
    const callWhitelistDelegation = <CallWhitelistDelegation>(
        await CallWhitelistDelegationFactory.deploy(delegationRegistryAddress)
    );
    await callWhitelistDelegation.deployed();

    const callWhitelistDelegationAddress = callWhitelistDelegation.address;
    console.log("CallWhitelistDelegation deployed to:", callWhitelistDelegationAddress);
    console.log(SUBSECTION_SEPARATOR);

    console.log("Writing to deployments json file...");

    await writeJson(
        whitelistAddress,
        baseURIDescriptorAddress,
        feeControllerAddress,
        assetVaultAddress,
        vaultFactoryAddress,
        borrowerNoteAddress,
        lenderNoteAddress,
        loanCoreAddress,
        repaymentContAddress,
        originationContAddress,
        verifierAddress,
        bNoteName,
        bNoteSymbol,
        lNoteName,
        lNoteSymbol,
        BASE_URI,
        punksVerifierAddress,
        collectionWideOfferVerifierAddress,
        artBlocksVerifierAddress,
        unvaultedItemsVerifierAddress,
        callWhitelistApprovalsAddress,
        delegationRegistryAddress,
        callWhitelistDelegationAddress,
    );

    console.log(SECTION_SEPARATOR);

    return {
        assetVault,
        feeController,
        loanCore,
        borrowerNote,
        lenderNote,
        repaymentController,
        originationController,
        whitelist,
        vaultFactory,
        verifier,
        baseURIDescriptor,
        punksVerifier,
        collectionWideOfferVerifier,
        artBlocksVerifier,
        unvaultedItemsVerifier,
        callWhitelistApprovals,
        delegationRegistry,
        callWhitelistDelegation,
    };
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
