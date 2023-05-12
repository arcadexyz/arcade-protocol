import fs from "fs";
import path from "path";
import hre from "hardhat";
import { BigNumberish } from "ethers";

export interface ContractData {
    contractAddress: string;
    constructorArgs: BigNumberish[];
}

export interface DeploymentData {
    [contractName: string]: ContractData;
}

export async function writeJson(
    whitelistAddress: string,
    baseURIDescriptorAddress: string,
    feeControllerAddress: string,
    assetVaultAddress: string,
    vaultFactoryAddress: string,
    borrowerNoteAddress: string,
    lenderNoteAddress: string,
    loanCoreAddress: string,
    repaymentContAddress: string,
    originationContAddress: string,
    verifierAddress: string,
    bNoteName: string,
    bNoteSymbol: string,
    lNoteName: string,
    lNoteSymbol: string,
    BASE_URI: string,
): Promise<void> {
    const timestamp = Math.floor(new Date().getTime() / 1000);
    const networkName = hre.network.name;
    const deploymentsFolder = `.deployments`;
    const jsonFile = `${networkName}-${timestamp}.json`;

    const deploymentsFolderPath = path.join(__dirname, "../../", deploymentsFolder);
    if (!fs.existsSync(deploymentsFolderPath)) fs.mkdirSync(deploymentsFolderPath);

    const networkFolderPath = path.join(deploymentsFolderPath, networkName);
    if (!fs.existsSync(networkFolderPath)) fs.mkdirSync(networkFolderPath);

    const contractInfo = await createInfo(
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
        BASE_URI
    );

    fs.writeFileSync(path.join(networkFolderPath, jsonFile), JSON.stringify(contractInfo, undefined, 2));

    console.log("Contract info written to: ", path.join(networkFolderPath, jsonFile));
}

export async function createInfo(
    whitelistAddress: string,
    baseURIDescriptorAddress: string,
    feeControllerAddress: string,
    assetVaultAddress: string,
    vaultFactoryAddress: string,
    borrowerNoteAddress: string,
    lenderNoteAddress: string,
    loanCoreAddress: string,
    repaymentContAddress: string,
    originationContAddress: string,
    verifierAddress: string,
    bNoteName: string,
    bNoteSymbol: string,
    lNoteName: string,
    lNoteSymbol: string,
    BASE_URI: string,
): Promise<DeploymentData> {
    const contractInfo: DeploymentData = {};

    contractInfo["CallWhitelist"] = {
        contractAddress: whitelistAddress,
        constructorArgs: [],
    };

    contractInfo["BaseURIDescriptor"] = {
        contractAddress: baseURIDescriptorAddress,
        constructorArgs: [BASE_URI],
    };

    contractInfo["FeeController"] = {
        contractAddress: feeControllerAddress,
        constructorArgs: [],
    };

    contractInfo["AssetVault"] = {
        contractAddress: assetVaultAddress,
        constructorArgs: [],
    };

    contractInfo["VaultFactory"] = {
        contractAddress: vaultFactoryAddress,
        constructorArgs: [
            assetVaultAddress,
            whitelistAddress,
            feeControllerAddress,
            BASE_URI
        ],
    };

    contractInfo["BorrowerNote"] = {
        contractAddress: borrowerNoteAddress,
        constructorArgs: [
            bNoteName,
            bNoteSymbol,
            BASE_URI],
    };

    contractInfo["LenderNote"] = {
        contractAddress: lenderNoteAddress,
        constructorArgs: [
            lNoteName,
            lNoteSymbol,
            BASE_URI
        ],
    };

    contractInfo["LoanCore"] = {
        contractAddress: loanCoreAddress,
        constructorArgs: [
            borrowerNoteAddress,
            lenderNoteAddress
        ],
    };

    contractInfo["RepaymentController"] = {
        contractAddress: repaymentContAddress,
        constructorArgs: [
            loanCoreAddress,
            feeControllerAddress
        ],
    };

    contractInfo["OriginationController"] = {
        contractAddress: originationContAddress,
        constructorArgs: [
            loanCoreAddress,
            feeControllerAddress
        ],
    };

    contractInfo["ArcadeItemsVerifier"] = {
        contractAddress: verifierAddress,
        constructorArgs: [],
    };

    return contractInfo;
}
