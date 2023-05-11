import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber, BigNumberish, ethers } from "ethers";

import { LoanCore, VaultFactory } from "../../typechain";
import { SignatureItem, ItemsPredicate, ArtBlocksItem } from "./types";
import { LoanTerms } from "./types";

export const initializeBundle = async (vaultFactory: VaultFactory, user: SignerWithAddress): Promise<BigNumber> => {
    const tx = await vaultFactory.connect(user).initializeBundle(await user.getAddress());
    const receipt = await tx.wait();

    if (receipt && receipt.events) {
        for (const event of receipt.events) {
            if (event.event && event.event === "VaultCreated" && event.args && event.args.vault) {
                return event.args.vault;
            }
        }
        throw new Error("Unable to initialize bundle");
    } else {
        throw new Error("Unable to initialize bundle");
    }
};

export const encodeSignatureItems = (items: SignatureItem[]): string => {
    const types = ["(uint256,address,uint256,uint256,bool)[]"];
    const values = items.map(item => [item.cType, item.asset, item.tokenId, item.amount, item.anyIdAllowed]);

    return ethers.utils.defaultAbiCoder.encode(types, [values]);
};

export const encodeInts = (ints: BigNumberish[]): string => {
    const types = ["int256[]"];

    return ethers.utils.defaultAbiCoder.encode(types, [ints]);
}

export const encodeArtBlocksItems = (items: ArtBlocksItem[]): string => {
    const types = ["(address,uint256,uint256,uint256,bool)[]"];
    const values = items.map(item => [item.asset, item.projectId, item.tokenId, item.amount, item.anyIdAllowed]);

    return ethers.utils.defaultAbiCoder.encode(types, [values]);
};

export const encodePredicates = (predicates: ItemsPredicate[]): string => {
    const types = ["(bytes,address)[]"];
    const values = predicates.map(p => [p.data, p.verifier]);

    const coded = ethers.utils.defaultAbiCoder.encode(types, [values]);
    return ethers.utils.keccak256(coded);
};

export const encodeItemCheck = (addr: string, id: BigNumberish, anyIdAllowed = false): string => {
    const types = ["address", "uint256", "bool"];

    return ethers.utils.defaultAbiCoder.encode(types, [addr, id, anyIdAllowed]);
}

export const startLoan = async (
    loanCore: LoanCore,
    originator: SignerWithAddress,
    lender: string,
    borrower: string,
    terms: LoanTerms,
    amountFromLender: BigNumberish,
    amountToBorrower: BigNumberish,
): Promise<BigNumber> => {
    const tx = await loanCore.connect(originator).startLoan(lender, borrower, terms, amountFromLender, amountToBorrower);
    const receipt = await tx.wait();

    const loanStartedEvent = receipt?.events?.find(e => e.event === "LoanStarted");

    expect(loanStartedEvent).to.not.be.undefined;
    expect(loanStartedEvent?.args?.[1]).to.eq(lender);
    expect(loanStartedEvent?.args?.[2]).to.eq(borrower);

    const loanId = loanStartedEvent?.args?.[0];

    return loanId;
};
