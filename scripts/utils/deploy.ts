import fs from "fs";
import { ethers } from "hardhat";
import { Contract } from "ethers";

import {
    CallWhitelistAllExtensions,
    AssetVault,
    BaseURIDescriptor,
    FeeController,
    VaultFactory,
    PromissoryNote,
    LoanCore,
    RepaymentController,
    OriginationController,
    ArcadeItemsVerifier,
    CollectionWideOfferVerifier,
    ArtBlocksVerifier,
} from "../../typechain";

export interface ContractArgs {
    whitelist: CallWhitelistAllExtensions;
    vaultFactoryURIDescriptor: BaseURIDescriptor;
    feeController: FeeController;
    assetVault: AssetVault;
    vaultFactory: VaultFactory;
    borrowerNoteURIDescriptor: BaseURIDescriptor;
    borrowerNote: PromissoryNote;
    lenderNoteURIDescriptor: BaseURIDescriptor;
    lenderNote: PromissoryNote;
    loanCore: LoanCore;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    verifier: ArcadeItemsVerifier;
    collectionWideOfferVerifier: CollectionWideOfferVerifier;
    artBlocksVerifier: ArtBlocksVerifier;
};

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
    ArcadeItemsVerifier: "verifier",
    CollectionWideOfferVerifier: "collectionWideOfferVerifier",
    ArtBlocksVerifier: "artBlocksVerifier",
};

export async function loadContracts(jsonFile: string): Promise<ContractArgs> {
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
            contract = await ethers.getContractAt("BaseURIDescriptor", jsonData[key]["contractAddress"]);
        } else {
            contract = await ethers.getContractAt(key, jsonData[key]["contractAddress"]);
        }

        contracts[argKey] = contract;
    }

    return contracts as unknown as ContractArgs;
}