import hre from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumberish } from "ethers";
import { LoanTerms, ItemsPayload, ItemsPredicate, InitializeLoanSignature } from "./types";
import { fromRpcSig, ECDSASignature } from "ethereumjs-util";

interface TypeData {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    primaryType: any;
}

export interface PermitData {
    owner: string;
    spender: string;
    tokenId: BigNumberish;
    nonce: BigNumberish;
    deadline: BigNumberish;
}

const typedPermitData: TypeData = {
    types: {
        Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "tokenId", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
        ],
    },
    primaryType: "Permit" as const,
};

const typedLoanTermsData: TypeData = {
    types: {
        LoanTerms: [
            { name: "durationSecs", type: "uint32" },
            { name: "deadline", type: "uint32" },
            { name: "proratedInterestRate", type: "uint160" },
            { name: "principal", type: "uint256" },
            { name: "collateralAddress", type: "address" },
            { name: "collateralId", type: "uint256" },
            { name: "payableCurrency", type: "address" },
            { name: "affiliateCode", type: "bytes32" },
            { name: "nonce", type: "uint160" },
            { name: "side", type: "uint8" },
        ],
    },
    primaryType: "LoanTerms" as const,
};

const typedLoanItemsData: TypeData = {
    types: {
        LoanTermsWithItems: [
            { name: "durationSecs", type: "uint32" },
            { name: "deadline", type: "uint32" },
            { name: "proratedInterestRate", type: "uint160" },
            { name: "principal", type: "uint256" },
            { name: "collateralAddress", type: "address" },
            { name: "items", type: "Predicate[]" },
            { name: "payableCurrency", type: "address" },
            { name: "affiliateCode", type: "bytes32" },
            { name: "nonce", type: "uint160" },
            { name: "side", type: "uint8" },
        ],
        Predicate: [
            { name: "data", type: "bytes" },
            { name: "verifier", type: "address" },
        ],
    },
    primaryType: "LoanTermsWithItems" as const,
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
 * @param version The EIP712 version of the contract to use
 * @param nonce The signature nonce
 * @param side The side of the loan
 */
export async function createLoanTermsSignature(
    verifyingContract: string,
    name: string,
    terms: LoanTerms,
    signer: SignerWithAddress,
    version = "3",
    nonce: BigNumberish,
    _side: "b" | "l",
): Promise<InitializeLoanSignature> {
    const side = _side === "b" ? 0 : 1;
    const data = buildData(verifyingContract, name, version, { ...terms, nonce, side }, typedLoanTermsData);
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    const sig: ECDSASignature =  fromRpcSig(signature);

    return { v: sig.v, r: sig.r, s: sig.s, extraData: "0x" };
}

/**
 * Create an EIP712 signature for loan terms
 * @param verifyingContract The address of the contract that will be verifying this signature
 * @param name The name of the contract that will be verifying this signature
 * @param terms the LoanTerms object to sign
 * @param signer The EOA to create the signature
 * @param version The EIP712 version of the contract to use
 * @param nonce The signature nonce
 * @param side The side of the loan
 */
export async function createLoanItemsSignature(
    verifyingContract: string,
    name: string,
    terms: LoanTerms,
    items: ItemsPredicate[],
    signer: SignerWithAddress,
    version = "3",
    nonce = "1",
    _side: "b" | "l",
): Promise<InitializeLoanSignature> {
    const side = _side === "b" ? 0 : 1;

    const message: ItemsPayload = {
        durationSecs: terms.durationSecs,
        principal: terms.principal,
        proratedInterestRate: terms.proratedInterestRate,
        collateralAddress: terms.collateralAddress,
        items,
        payableCurrency: terms.payableCurrency,
        nonce,
        side,
        deadline: terms.deadline,
        affiliateCode: terms.affiliateCode
    };

    const data = buildData(verifyingContract, name, version, message, typedLoanItemsData);
    // console.log("This is data:");
    // console.log(JSON.stringify(data, null, 4));
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    const sig: ECDSASignature =  fromRpcSig(signature);

    return { v: sig.v, r: sig.r, s: sig.s, extraData: "0x" };
}

/**
 * Create an EIP712 signature for ERC721 permit
 * @param verifyingContract The address of the contract that will be verifying this signature
 * @param name The name of the contract that will be verifying this signature
 * @param permitData the data of the permit to sign
 * @param signer The EOA to create the signature
 */
export async function createPermitSignature(
    verifyingContract: string,
    name: string,
    permitData: PermitData,
    signer: SignerWithAddress,
): Promise<InitializeLoanSignature> {
    const data = buildData(verifyingContract, name, "1", permitData, typedPermitData);
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    const sig: ECDSASignature =  fromRpcSig(signature);

    return { v: sig.v, r: sig.r, s: sig.s, extraData: "0x" };
}