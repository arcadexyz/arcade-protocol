import hre from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumberish } from "ethers";
import { LoanTerms, ItemsPredicate, InitializeLoanSignature, SignatureProperties, LoanTermsWithItems, LoanWithItems, Loan } from "./types";
import { fromRpcSig, ECDSASignature } from "ethereumjs-util";
import { EIP712_VERSION } from "./constants";

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

const typedLoanData: TypeData = {
    types: {
        Loan: [
            { name: "terms", type: "LoanTerms" },
            { name: "sigProperties", type: "SigProperties" },
            { name: "side", type: "uint8" },
            { name: "signingCounterparty", type: "address"},
            { name: "callbackData", type: "bytes"}
        ],
        LoanTerms: [
            { name: "interestRate", type: "uint32" },
            { name: "durationSecs", type: "uint64" },
            { name: "collateralAddress", type: "address" },
            { name: "deadline", type: "uint96" },
            { name: "payableCurrency", type: "address" },
            { name: "principal", type: "uint256" },
            { name: "collateralId", type: "uint256" },
            { name: "affiliateCode", type: "bytes32" },
        ],
        SigProperties: [
            { name: "nonce", type: "uint160" },
            { name: "maxUses", type: "uint96" },
        ],
    },
    primaryType: "Loan" as const,
};

const typedLoanItemsData: TypeData = {
    types: {
        LoanWithItems: [
            { name: "termsWithItems", type: "LoanTermsWithItems" },
            { name: "sigProperties", type: "SigProperties" },
            { name: "side", type: "uint8" },
            { name: "signingCounterparty", type: "address"},
            { name: "callbackData", type: "bytes"}
        ],
        SigProperties: [
            { name: "nonce", type: "uint160" },
            { name: "maxUses", type: "uint96" },
        ],
        LoanTermsWithItems: [
            { name: "interestRate", type: "uint32" },
            { name: "durationSecs", type: "uint64" },
            { name: "collateralAddress", type: "address" },
            { name: "deadline", type: "uint96" },
            { name: "payableCurrency", type: "address" },
            { name: "principal", type: "uint256" },
            { name: "affiliateCode", type: "bytes32" },
            { name: "items", type: "Predicate[]" },
        ],
        Predicate: [
            { name: "data", type: "bytes" },
            { name: "verifier", type: "address" },
        ],
    },
    primaryType: "LoanWithItems" as const,
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
 * @param sigProperties The signature nonce and max uses for that nonce
 * @param side The side of the loan
 * @param extraData Any data to append to the signature
 */
export async function createLoanTermsSignature(
    verifyingContract: string,
    name: string,
    terms: LoanTerms,
    signer: SignerWithAddress,
    version = EIP712_VERSION,
    sigProperties: SignatureProperties,
    _side: "b" | "l",
    extraData = "0x",
    _signingCounterparty?: string,
    callbackData= "0x",
): Promise<InitializeLoanSignature> {
    const side = _side === "b" ? 0 : 1;
    const signingCounterparty = _signingCounterparty ?? signer.address;
    const message: Loan = {
        terms,
        sigProperties,
        side,
        signingCounterparty,
        callbackData: callbackData,
    }
    const data = buildData(verifyingContract, name, version, message, typedLoanData);
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
 * @param sigProperties The signature nonce and max uses for that nonce
 * @param side The side of the loan
 * @param extraData Any data to append to the signature
 */
export async function createLoanItemsSignature(
    verifyingContract: string,
    name: string,
    terms: LoanTerms,
    items: ItemsPredicate[],
    signer: SignerWithAddress,
    version = EIP712_VERSION,
    sigProperties: SignatureProperties,
    _side: "b" | "l",
    extraData = "0x",
    _signingCounterparty?: string,
    callbackData= "0x",
): Promise<InitializeLoanSignature> {
    const side = _side === "b" ? 0 : 1;
    const signingCounterparty = _signingCounterparty ?? signer.address;
    const termsWithItems: LoanTermsWithItems = {
        ...terms,
        items,
    };
    const message: LoanWithItems = {
        termsWithItems,
        sigProperties,
        side,
        signingCounterparty,
        callbackData: callbackData,
    };

    const data = buildData(verifyingContract, name, version, message, typedLoanItemsData);
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    const sig: ECDSASignature =  fromRpcSig(signature);

    return { v: sig.v, r: sig.r, s: sig.s, extraData };
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
    extraData = "0x",
): Promise<InitializeLoanSignature> {
    const data = buildData(verifyingContract, name, "1", permitData, typedPermitData);
    const signature = await signer._signTypedData(data.domain, data.types, data.message);

    const sig: ECDSASignature =  fromRpcSig(signature);

    return { v: sig.v, r: sig.r, s: sig.s, extraData };
}
