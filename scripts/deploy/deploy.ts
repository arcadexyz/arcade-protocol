import { ethers } from "hardhat";

import { recordDeployment } from "./record-deployment";
import {
    SECTION_SEPARATOR,
    SUBSECTION_SEPARATOR,
    VAULT_FACTORY_BASE_URI,
    BORROWER_NOTE_BASE_URI,
    LENDER_NOTE_BASE_URI,
    DELEGATION_REGISTRY_ADDRESS,
    BORROWER_NOTE_NAME,
    BORROWER_NOTE_SYMBOL,
    LENDER_NOTE_NAME,
    LENDER_NOTE_SYMBOL
 } from "../utils/constants";

import {
    AssetVault,
    FeeController,
    LoanCore,
    PromissoryNote,
    RepaymentController,
    OriginationController,
    ArcadeItemsVerifier,
    VaultFactory,
    StaticURIDescriptor,
    CollectionWideOfferVerifier,
    ArtBlocksVerifier,
    CallWhitelistAllExtensions
} from "../../typechain";

export interface DeployedResources {
    whitelist: CallWhitelistAllExtensions;
    vaultFactoryURIDescriptor: StaticURIDescriptor;
    feeController: FeeController;
    assetVault: AssetVault;
    vaultFactory: VaultFactory;
    loanCore: LoanCore;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    borrowerNoteURIDescriptor: StaticURIDescriptor;
    borrowerNote: PromissoryNote;
    lenderNoteURIDescriptor: StaticURIDescriptor;
    lenderNote: PromissoryNote;
    arcadeItemsVerifier: ArcadeItemsVerifier;
    collectionWideOfferVerifier: CollectionWideOfferVerifier;
    artBlocksVerifier: ArtBlocksVerifier;
}

export async function main(): Promise<void> {
    // Hardhat always runs the compile task when running scripts through it.
    // If this runs in a standalone fashion you may want to call compile manually
    // to make sure everything is compiled
    // await run("compile");

    console.log(SECTION_SEPARATOR);

    const CallWhiteListFactory = await ethers.getContractFactory("CallWhitelistAllExtensions");
    const whitelist = <CallWhitelistAllExtensions>await CallWhiteListFactory.deploy(DELEGATION_REGISTRY_ADDRESS);
    await whitelist.deployed();

    console.log("CallWhitelistAllExtensions deployed to:", whitelist.address);
    console.log(SUBSECTION_SEPARATOR);

    const AssetVaultFactory = await ethers.getContractFactory("AssetVault");
    const assetVault = <AssetVault>await AssetVaultFactory.deploy();
    await assetVault.deployed();

    console.log("AssetVault deployed to:", assetVault.address);
    console.log(SUBSECTION_SEPARATOR);

    const StaticURIDescriptorFactory = await ethers.getContractFactory("StaticURIDescriptor");
    const vfURIDescriptor = <StaticURIDescriptor>await StaticURIDescriptorFactory.deploy(`${VAULT_FACTORY_BASE_URI}`);
    await vfURIDescriptor.deployed();

    console.log("Vault Factory URI Descriptor deployed to:", vfURIDescriptor.address);
    console.log(SUBSECTION_SEPARATOR);

    const FeeControllerFactory = await ethers.getContractFactory("FeeController");
    const feeController = <FeeController>await FeeControllerFactory.deploy();
    await feeController.deployed();

    console.log("FeeController deployed to: ", feeController.address);
    console.log(SUBSECTION_SEPARATOR);

    const VaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
    const vaultFactory = <VaultFactory>(
        await VaultFactoryFactory.deploy(
            assetVault.address,
            whitelist.address,
            feeController.address,
            vfURIDescriptor.address,
        )
    );

    await vaultFactory.deployed();

    console.log("VaultFactory deployed to:", vaultFactory.address);
    console.log(SUBSECTION_SEPARATOR);

    const PromissoryNoteFactory = await ethers.getContractFactory("PromissoryNote");

    const borrowerNoteURIDescriptor = <StaticURIDescriptor>(
        await StaticURIDescriptorFactory.deploy(`${BORROWER_NOTE_BASE_URI}`)
    );
    await borrowerNoteURIDescriptor.deployed();

    const borrowerNote = <PromissoryNote>(
        await PromissoryNoteFactory.deploy(
            BORROWER_NOTE_NAME,
            BORROWER_NOTE_SYMBOL,
            borrowerNoteURIDescriptor.address
        )
    );
    await borrowerNote.deployed();

    console.log("BorrowerNote deployed to:", borrowerNote.address);

    const lenderNoteURIDescriptor = <StaticURIDescriptor>(
        await StaticURIDescriptorFactory.deploy(`${LENDER_NOTE_BASE_URI}`)
    );
    await lenderNoteURIDescriptor.deployed();

    const lenderNote = <PromissoryNote>(
        await PromissoryNoteFactory.deploy(
            LENDER_NOTE_NAME,
            LENDER_NOTE_SYMBOL,
            lenderNoteURIDescriptor.address
        )
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
        await RepaymentControllerFactory.deploy(
            loanCore.address,
            feeController.address
        )
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

    console.log("Writing to deployments json file...");

    const resources: DeployedResources = {
        whitelist,
        vaultFactoryURIDescriptor: vfURIDescriptor,
        feeController,
        assetVault,
        vaultFactory,
        loanCore,
        repaymentController,
        originationController,
        borrowerNoteURIDescriptor,
        borrowerNote,
        lenderNoteURIDescriptor,
        lenderNote,
        arcadeItemsVerifier: verifier,
        collectionWideOfferVerifier,
        artBlocksVerifier
    }

    await recordDeployment(
        resources,
        {
            whitelist: [DELEGATION_REGISTRY_ADDRESS],
            vaultFactoryURIDescriptor: [VAULT_FACTORY_BASE_URI],
            vaultFactory: [
                assetVault.address,
                whitelist.address,
                feeController.address,
                vfURIDescriptor.address,
            ],
            borrowerNoteURIDescriptor: [BORROWER_NOTE_BASE_URI],
            borrowerNote: [
                BORROWER_NOTE_NAME,
                BORROWER_NOTE_SYMBOL,
                borrowerNoteURIDescriptor.address
            ],
            lenderNoteURIDescriptor: [LENDER_NOTE_BASE_URI],
            lenderNote: [
                LENDER_NOTE_NAME,
                LENDER_NOTE_SYMBOL,
                lenderNoteURIDescriptor.address
            ],
            loanCore: [
                borrowerNote.address,
                lenderNote.address
            ],
            repaymentController: [
                loanCore.address,
                feeController.address
            ],
            originationController: [
                loanCore.address,
                feeController.address
            ]
        }
    );

    console.log(SECTION_SEPARATOR);

    console.log("✅ Deployment complete.");
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
