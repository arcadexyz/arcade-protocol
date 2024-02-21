import fs from "fs";
import { ethers } from "hardhat";
import { Contract } from "ethers";

import {
    AssetVault,
    FeeController,
    LoanCore,
    PromissoryNote,
    RepaymentController,
    ArcadeItemsVerifier,
    VaultFactory,
    StaticURIDescriptor,
    CollectionWideOfferVerifier,
    ArtBlocksVerifier,
    CallWhitelistAllExtensions,
    OriginationControllerMigrate,
    OriginationConfiguration
} from "../../typechain";

export interface DeployedResources {
    whitelist: CallWhitelistAllExtensions;
    vaultFactoryURIDescriptor: StaticURIDescriptor;
    feeController: FeeController;
    assetVault: AssetVault;
    vaultFactory: VaultFactory;
    loanCore: LoanCore;
    repaymentController: RepaymentController;
    originationController: OriginationControllerMigrate;
    originationConfiguration: OriginationConfiguration;
    borrowerNoteURIDescriptor: StaticURIDescriptor;
    borrowerNote: PromissoryNote;
    lenderNoteURIDescriptor: StaticURIDescriptor;
    lenderNote: PromissoryNote;
    arcadeItemsVerifier: ArcadeItemsVerifier;
    collectionWideOfferVerifier: CollectionWideOfferVerifier;
    artBlocksVerifier: ArtBlocksVerifier;
}

const jsonContracts: { [key: string]: string } = {
    CallWhitelistAllExtensions: "whitelist",
    AssetVault: "assetVault",
    VaultFactoryURIDescriptor: "vaultFactoryURIDescriptor",
    FeeController: "feeController",
    VaultFactory: "vaultFactory",
    BorrowerNoteURIDescriptor: "borrowerNoteURIDescriptor",
    BorrowerNote: "borrowerNote",
    LenderNoteURIDescriptor: "lenderNoteURIDescriptor",
    LenderNote: "lenderNote",
    LoanCore: "loanCore",
    RepaymentController: "repaymentController",
    OriginationController: "originationController",
    OriginationConfiguration: "originationConfiguration",
    ArcadeItemsVerifier: "arcadeItemsVerifier",
    CollectionWideOfferVerifier: "collectionWideOfferVerifier",
    ArtBlocksVerifier: "artBlocksVerifier",
};

export async function loadContracts(jsonFile: string): Promise<DeployedResources> {
    const readData = fs.readFileSync(jsonFile, 'utf-8');
    const jsonData = JSON.parse(readData);
    const contracts: { [key: string]: Contract } = {};

    for await (const key of Object.keys(jsonData)) {
        if (!(key in jsonContracts)) continue;

        const argKey = jsonContracts[key];
        console.log(`Key: ${key}, address: ${jsonData[key]["contractAddress"]}`);

        let contract: Contract;
        if (key.endsWith("Note")) {
            contract = await ethers.getContractAt("PromissoryNote", jsonData[key]["contractAddress"]);
        } else if (key.endsWith("Descriptor")) {
            contract = await ethers.getContractAt("StaticURIDescriptor", jsonData[key]["contractAddress"]);
        } else {
            contract = await ethers.getContractAt(key, jsonData[key]["contractAddress"]);
        }

        contracts[argKey] = contract;
    }

    return contracts as unknown as DeployedResources;
}