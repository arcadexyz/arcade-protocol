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
    assetVaultAddress: string,
    feeControllerAddress: string,
    borrowerNoteAddress: string,
    lenderNoteAddress: string,
    repaymentContAddress: string,
    whitelistAddress: string,
    vaultFactoryAddress: string,
    loanCoreAddress: string,
    originationContAddress: string,
    verifierAddress: string,
    bNoteName: string,
    bNoteSymbol: string,
    lNoteName: string,
    lNoteSymbol: string,
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
        assetVaultAddress,
        feeControllerAddress,
        borrowerNoteAddress,
        lenderNoteAddress,
        repaymentContAddress,
        whitelistAddress,
        vaultFactoryAddress,
        loanCoreAddress,
        originationContAddress,
        verifierAddress,
        bNoteName,
        bNoteSymbol,
        lNoteName,
        lNoteSymbol,
    );

    fs.writeFileSync(
        path.join(networkFolderPath, jsonFile),
        JSON.stringify(contractInfo, undefined, 2)
    );

    console.log("Contract info written to: ", path.join(networkFolderPath, jsonFile));
}

export async function createInfo(
    assetVaultAddress: string,
    feeControllerAddress: string,
    borrowerNoteAddress: string,
    lenderNoteAddress: string,
    repaymentContAddress: string,
    whitelistAddress: string,
    vaultFactoryAddress: string,
    loanCoreAddress: string,
    originationContAddress: string,
    verifierAddress: string,
    bNoteName: string,
    bNoteSymbol: string,
    lNoteName: string,
    lNoteSymbol: string,
): Promise<DeploymentData> {
    const contractInfo: DeploymentData = {};

    contractInfo["CallWhitelist"] = {
        contractAddress: whitelistAddress,
        constructorArgs: []
    };

    contractInfo["AssetVault"] = {
        contractAddress: assetVaultAddress,
        constructorArgs: []
    };

    contractInfo["VaultFactory"] = {
        contractAddress: vaultFactoryAddress,
        constructorArgs: []
    };

    contractInfo["FeeController"] = {
        contractAddress: feeControllerAddress,
        constructorArgs: []
    };

    contractInfo["BorrowerNote"] = {
        contractAddress: borrowerNoteAddress,
        constructorArgs: [bNoteName, bNoteSymbol]
    };

    contractInfo["LenderNote"] = {
        contractAddress: lenderNoteAddress,
        constructorArgs: [lNoteName, lNoteSymbol]
    };

    contractInfo["LoanCore"] = {
        contractAddress: loanCoreAddress,
        constructorArgs: [],
    };

    contractInfo["RepaymentController"] = {
        contractAddress: repaymentContAddress,
        constructorArgs: [loanCoreAddress]
    };

    contractInfo["OriginationController"] = {
        contractAddress: originationContAddress,
        constructorArgs: []
    };

    contractInfo["ArcadeItemsVerifier"] = {
        contractAddress: verifierAddress,
        constructorArgs: []
    };

    return contractInfo;
}
