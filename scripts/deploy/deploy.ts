import hre, { ethers } from "hardhat";

import { writeJson } from "./write-json";
import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../utils/bootstrap-tools";

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
    verifier: ArcadeItemsVerifier
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

    const AssetVaultFactory = await ethers.getContractFactory("AssetVault");
    const assetVault = <AssetVault>await AssetVaultFactory.deploy();
    await assetVault.deployed();

    const assetVaultAddress = assetVault.address;
    console.log("AssetVault deployed to:", assetVaultAddress);
    console.log(SUBSECTION_SEPARATOR);

    const VaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
    const vaultFactory = <VaultFactory>await VaultFactoryFactory.deploy(
        assetVault.address,
        whitelist.address
    );
    await vaultFactory.deployed();

    const vaultFactoryProxyAddress = vaultFactory.address;
    console.log("VaultFactory proxy deployed to:", vaultFactoryProxyAddress);
    console.log(SUBSECTION_SEPARATOR);

    const FeeControllerFactory = await ethers.getContractFactory("FeeController");
    const feeController = <FeeController>await FeeControllerFactory.deploy();
    await feeController.deployed();

    const feeControllerAddress = feeController.address;
    console.log("FeeController deployed to: ", feeControllerAddress);
    console.log(SUBSECTION_SEPARATOR);

    const bNoteName = "Arcade.xyz BorrowerNote";
    const bNoteSymbol = "aBN";
    const PromissoryNoteFactory = await ethers.getContractFactory("PromissoryNote");
    const borrowerNote = <PromissoryNote>await PromissoryNoteFactory.deploy(bNoteName, bNoteSymbol);
    await borrowerNote.deployed();

    const borrowerNoteAddress = borrowerNote.address;
    console.log("BorrowerNote deployed to:", borrowerNote.address);

    const lNoteName = "Arcade.xyz LenderNote";
    const lNoteSymbol = "aLN";
    const lenderNote = <PromissoryNote>await PromissoryNoteFactory.deploy(lNoteName, lNoteSymbol);
    await lenderNote.deployed();

    const lenderNoteAddress = lenderNote.address;
    console.log("LenderNote deployed to:", lenderNoteAddress);
    console.log(SUBSECTION_SEPARATOR);

    const LoanCoreFactory = await ethers.getContractFactory("LoanCore");
    const loanCore = <LoanCore>await LoanCoreFactory.deploy(
        feeController.address,
        borrowerNote.address,
        lenderNote.address
    );

    await loanCore.deployed();

    const loanCoreProxyAddress = loanCore.address;
    console.log("LoanCore proxy deployed to:", loanCoreProxyAddress);
    console.log(SUBSECTION_SEPARATOR);

    const RepaymentControllerFactory = await ethers.getContractFactory("RepaymentController");
    const repaymentController = <RepaymentController>(
        await RepaymentControllerFactory.deploy(loanCore.address)
    );
    await repaymentController.deployed();

    const repaymentContAddress = repaymentController.address;
    console.log("RepaymentController deployed to:", repaymentContAddress);

    console.log(SUBSECTION_SEPARATOR);

    const OriginationControllerFactory = await ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>await OriginationControllerFactory.deploy(
        loanCore.address
    );
    await originationController.deployed();

    const originationContProxyAddress = originationController.address;
    console.log("OriginationController proxy deployed to:", originationContProxyAddress);

    console.log(SUBSECTION_SEPARATOR);

    const VerifierFactory = await ethers.getContractFactory("ArcadeItemsVerifier");
    const verifier = <ArcadeItemsVerifier>await VerifierFactory.deploy();
    await verifier.deployed();

    const verifierAddress = verifier.address;
    console.log("ItemsVerifier deployed to:", verifierAddress);

    console.log(SUBSECTION_SEPARATOR);

    console.log("Writing to deployments json file...");

    await writeJson(
        assetVaultAddress,
        feeControllerAddress,
        borrowerNoteAddress,
        lenderNoteAddress,
        repaymentContAddress,
        whitelistAddress,
        vaultFactoryProxyAddress,
        loanCoreProxyAddress,
        originationContProxyAddress,
        verifierAddress,
        bNoteName,
        bNoteSymbol,
        lNoteName,
        lNoteSymbol,
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
        verifier
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
