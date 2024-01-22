import hre from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber, BigNumberish, BytesLike } from "ethers";
import { ItemsPredicate, InitializeLoanSignature } from "../../test/utils/types";
import { fromRpcSig, ECDSASignature } from "ethereumjs-util";

export interface V3LoanTerms {
    proratedInterestRate: BigNumberish;
    durationSecs: BigNumberish;
    collateralAddress: string;
    deadline: BigNumberish;
    payableCurrency: string;
    principal: BigNumber;
    collateralId: BigNumberish;
    affiliateCode: BytesLike;
}

export interface ItemsPayload {
    interestRate: BigNumberish;
    durationSecs: BigNumberish;
    collateralAddress: string;
    deadline: BigNumberish;
    payableCurrency: string;
    principal: BigNumber;
    affiliateCode: BytesLike;
    items: ItemsPredicate[];
    nonce: BigNumberish;
    side: 0 | 1;
}

interface TypeData {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    primaryType: any;
}

const typedV3LoanTermsData: TypeData = {
    types: {
        LoanTerms: [
            { name: "proratedInterestRate", type: "uint256" },
            { name: "principal", type: "uint256" },
            { name: "collateralAddress", type: "address" },
            { name: "durationSecs", type: "uint96" },
            { name: "collateralId", type: "uint256" },
            { name: "payableCurrency", type: "address" },
            { name: "deadline", type: "uint96" },
            { name: "affiliateCode", type: "bytes32" },
            { name: "nonce", type: "uint160" },
            { name: "side", type: "uint8" },
        ],
    },
    primaryType: "LoanTerms" as const,
};

const typedV3LoanItemsData: TypeData = {
    types: {
        LoanTermsWithItems: [
            { name: "proratedInterestRate", type: "uint256" },
            { name: "principal", type: "uint256" },
            { name: "collateralAddress", type: "address" },
            { name: "durationSecs", type: "uint96" },
            { name: "items", type: "Predicate[]" },
            { name: "payableCurrency", type: "address" },
            { name: "deadline", type: "uint96" },
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
 * @param extraData Any data to append to the signature
 */
export async function createV3LoanTermsSignature(
    verifyingContract: string,
    name: string,
    terms: V3LoanTerms,
    signer: SignerWithAddress,
    version = "3",
    nonce: BigNumberish,
    _side: "b" | "l",
    extraData = "0x",
): Promise<InitializeLoanSignature> {
    const side = _side === "b" ? 0 : 1;
    const data = buildData(verifyingContract, name, version, { ...terms, nonce, side }, typedV3LoanTermsData);
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    const sig: ECDSASignature =  fromRpcSig(signature);

    return { v: sig.v, r: sig.r, s: sig.s, extraData };
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
 * @param extraData Any data to append to the signature
 */
export async function createV3LoanItemsSignature(
    verifyingContract: string,
    name: string,
    terms: V3LoanTerms,
    items: ItemsPredicate[],
    signer: SignerWithAddress,
    version = "3",
    nonce: BigNumberish,
    _side: "b" | "l",
    extraData = "0x",
): Promise<InitializeLoanSignature> {
    const side = _side === "b" ? 0 : 1;
    const message: ItemsPayload = {
        interestRate: terms.proratedInterestRate,
        durationSecs: terms.durationSecs,
        collateralAddress: terms.collateralAddress,
        deadline: terms.deadline,
        payableCurrency: terms.payableCurrency,
        principal: terms.principal,
        affiliateCode: terms.affiliateCode,
        items,
        nonce,
        side
    };

    const data = buildData(verifyingContract, name, version, message, typedV3LoanItemsData);
    // console.log("This is data:");
    // console.log(JSON.stringify(data, null, 4));
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    const sig: ECDSASignature =  fromRpcSig(signature);

    return { v: sig.v, r: sig.r, s: sig.s, extraData };
}
