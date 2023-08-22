import fs from "fs";
import path from "path";
import hre from "hardhat";
import { BigNumberish } from "ethers";

import { DeployedResources } from "./deploy";
import { BORROWER_NOTE_BASE_URI, VAULT_FACTORY_BASE_URI } from "../utils/constants";

export interface ContractData {
    contractAddress: string;
    constructorArgs: BigNumberish[];
}

export interface DeploymentData {
    [contractName: string]: ContractData;
}

export async function recordDeployment(
    resources: DeployedResources,
    constructorArgs: { [contractName: string]: BigNumberish[] }
): Promise<void> {
    const timestamp = Math.floor(new Date().getTime() / 1000);
    const networkName = hre.network.name;
    const deploymentsFolder = `.deployments`;
    const jsonFile = `${networkName}-${timestamp}.json`;

    const deploymentsFolderPath = path.join(__dirname, "../../", deploymentsFolder);
    if (!fs.existsSync(deploymentsFolderPath)) fs.mkdirSync(deploymentsFolderPath);

    const networkFolderPath = path.join(deploymentsFolderPath, networkName);
    if (!fs.existsSync(networkFolderPath)) fs.mkdirSync(networkFolderPath);

    const contractInfo: DeploymentData = {};

    contractInfo["CallWhitelistAllExtensions"] = {
        contractAddress: resources.whitelist.address,
        constructorArgs: constructorArgs.whitelist,
    };

    contractInfo["AssetVault"] = {
        contractAddress: resources.assetVault.address,
        constructorArgs: [],
    };

    contractInfo["VaultFactoryURIDescriptor"] = {
        contractAddress: resources.vaultFactoryURIDescriptor.address,
        constructorArgs: constructorArgs.vaultFactoryURIDescriptor,
    };

    contractInfo["FeeController"] = {
        contractAddress: resources.feeController.address,
        constructorArgs: [],
    };

    contractInfo["VaultFactory"] = {
        contractAddress: resources.vaultFactory.address,
        constructorArgs: constructorArgs.vaultFactory,
    };

    contractInfo["BorrowerNoteURIDescriptor"] = {
        contractAddress: resources.borrowerNoteURIDescriptor.address,
        constructorArgs: constructorArgs.borrowerNoteURIDescriptor,
    };

    contractInfo["BorrowerNote"] = {
        contractAddress: resources.borrowerNote.address,
        constructorArgs: constructorArgs.borrowerNote,
    };

    contractInfo["LenderNoteURIDescriptor"] = {
        contractAddress: resources.lenderNoteURIDescriptor.address,
        constructorArgs: constructorArgs.lenderNoteURIDescriptor
    };

    contractInfo["LenderNote"] = {
        contractAddress: resources.lenderNote.address,
        constructorArgs: constructorArgs.lenderNote,
    };

    contractInfo["LoanCore"] = {
        contractAddress: resources.loanCore.address,
        constructorArgs: constructorArgs.loanCore,
    };

    contractInfo["RepaymentController"] = {
        contractAddress: resources.repaymentController.address,
        constructorArgs: constructorArgs.repaymentController,
    };

    contractInfo["OriginationController"] = {
        contractAddress: resources.originationController.address,
        constructorArgs: constructorArgs.originationController,
    };

    contractInfo["ArcadeItemsVerifier"] = {
        contractAddress: resources.arcadeItemsVerifier.address,
        constructorArgs: [],
    };

    contractInfo["CollectionWideOfferVerifier"] = {
        contractAddress: resources.collectionWideOfferVerifier.address,
        constructorArgs: [],
    };

    contractInfo["ArtBlocksVerifier"] = {
        contractAddress: resources.artBlocksVerifier.address,
        constructorArgs: [],
    };

    fs.writeFileSync(path.join(networkFolderPath, jsonFile), JSON.stringify(contractInfo, undefined, 2));

    console.log("Contract info written to: ", path.join(networkFolderPath, jsonFile));
}