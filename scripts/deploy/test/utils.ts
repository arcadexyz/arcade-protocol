import fs from "fs";
import path from "path";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

import fetch from "node-fetch";
import { URLSearchParams } from "url";
import hre from "hardhat";
import { expect } from "chai";
import { fromRpcSig, ECDSASignature } from "ethereumjs-util";
import { InitializeLoanSignature } from "../../../test/utils/types";

export const NETWORK = hre.network.name;
export const IS_MAINNET_FORK = process.env.FORK_MAINNET === "true";
export const ROOT_DIR = path.join(__dirname, "../../../");
export const DEPLOYMENTS_DIR = path.join(ROOT_DIR, ".deployments", NETWORK);

export const getLatestDeploymentFile = (): string => {
    // Make sure JSON file exists
    const files = fs.readdirSync(DEPLOYMENTS_DIR);
    expect(files.length).to.be.gt(0);

    const { filename } = files.slice(1).reduce((result, file) => {
        const stats = fs.statSync(path.join(DEPLOYMENTS_DIR, file));

        if (stats.ctime > result.ctime) {
            result = {
                filename: file,
                ctime: stats.ctime
            };
        }

        return result;
    }, {
        filename: files[0],
        ctime: fs.statSync(path.join(DEPLOYMENTS_DIR, files[0])).ctime
    });

    return path.join(DEPLOYMENTS_DIR, filename);
}

export const getLatestDeployment = (): Record<string, any> => {
    const fileData = fs.readFileSync(getLatestDeploymentFile(), 'utf-8');
    const deployment = JSON.parse(fileData);

    return deployment;
}

export const getVerifiedABI = async (address: string ): Promise<any> => {
    // Wait 1 sec to get around rate limits
    await new Promise(done => setTimeout(done, 1000));

    const params = new URLSearchParams({
        module: 'contract',
        action: 'getabi',
        address,
        apikey: process.env.ETHERSCAN_API_KEY as string
    });

    const NETWORK = hre.network.name;
    const BASE_URL = NETWORK === "mainnet" ? "api.etherscan.io" : `api-${NETWORK}.etherscan.io`;

    const res = <any>await fetch(`https://${BASE_URL}/api?${params}`);
    const { result } = await res.json();

    return JSON.parse(result);
}

interface TypeData {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    primaryType: any;
}

const typedLoanTermsData: TypeData = {
    types: {
        LoanTerms: [
            { name: "durationSecs", type: "uint256" },
            { name: "principal", type: "uint256" },
            { name: "interest", type: "uint256" },
            { name: "collateralTokenId", type: "uint256" },
            { name: "payableCurrency", type: "address" },
        ],
    },
    primaryType: "LoanTerms" as const,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildData = (verifyingContract: string, name: string, version: string, message: any, typeData: TypeData) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const chainId = hre.network.config.chainId!;
    return Object.assign({}, typeData, {
        domain: {
            name,
            version,
            chainId,
            verifyingContract,
        },
        message,
    });
};

/**
 * Create an EIP712 signature for loan terms
 * @param verifyingContract The address of the contract that will be verifying this signature
 * @param name The name of the contract that will be verifying this signature
 * @param terms the LoanTerms object to sign
 * @param signer The EOA to create the signature
 */
export async function createLoanTermsSignature(
    verifyingContract: string,
    name: string,
    terms: any,
    signer: SignerWithAddress,
): Promise<InitializeLoanSignature> {
    const data = buildData(verifyingContract, name, "1", terms, typedLoanTermsData);

    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    const sig: ECDSASignature =  fromRpcSig(signature);

    return { v: sig.v, r: sig.r, s: sig.s, extraData: "0x" };
}
