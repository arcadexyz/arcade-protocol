import { BigNumber, BigNumberish, BytesLike } from "ethers";

export enum LoanState {
    DUMMY = 0,
    Active = 1,
    Repaid = 2,
    Defaulted = 3,
}

export interface SignatureItem {
    cType: 0 | 1 | 2;
    asset: string;
    tokenId: BigNumberish;
    amount: BigNumberish;
    anyIdAllowed: boolean;
}

export interface ArtBlocksItem {
    asset: string;
    projectId: BigNumberish;
    tokenId: BigNumberish;
    amount: BigNumberish;
    anyIdAllowed: boolean;
}

export interface ItemsPredicate {
    data: string;
    verifier: string;
}

export interface LoanTerms {
    durationSecs: BigNumberish;
    principal: BigNumber;
    proratedInterestRate: BigNumber;
    collateralAddress: string;
    collateralId: BigNumberish;
    payableCurrency: string;
    deadline: BigNumberish;
    affiliateCode: BytesLike;
}

export interface ItemsPayload {
    durationSecs: BigNumberish;
    principal: BigNumber;
    proratedInterestRate: BigNumber;
    collateralAddress: string;
    items: ItemsPredicate[];
    payableCurrency: string;
    affiliateCode: BytesLike;
    nonce: BigNumberish;
    side: 0 | 1;
    deadline: BigNumberish;
}

export interface LoanData {
    terms: LoanTerms;
    state: LoanState;
    startDate: BigNumberish;
}
