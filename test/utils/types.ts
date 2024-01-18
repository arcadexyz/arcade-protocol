import { BigNumber, BigNumberish, BytesLike } from "ethers";

export enum LoanState {
    DUMMY = 0,
    Active = 1,
    Repaid = 2,
    Defaulted = 3,
}

// Arcade Items Verifier signature item
export interface SignatureItem {
    cType: 0 | 1 | 2;
    asset: string;
    tokenId: BigNumberish;
    amount: BigNumberish;
    anyIdAllowed: boolean;
}

// Art Blocks Verifier signature item
export interface ABSignatureItem {
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

export interface SignatureProperties {
    nonce: BigNumberish;
    maxUses: BigNumberish;

}

export interface LoanTerms {
    interestRate: BigNumberish;
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
    maxUses: BigNumberish;
    side: 0 | 1;
}

export interface FeeSnapshot {
    lenderDefaultFee: BigNumberish;
    lenderInterestFee: BigNumberish;
    lenderPrincipalFee: BigNumberish;
}

export interface LoanData {
    state: LoanState;
    startDate: BigNumberish;
    lastAccrualTimestamp: BigNumberish;
    terms: LoanTerms;
    feeSnapshot: FeeSnapshot;
    balance: BigNumber;
    interestAmountPaid: BigNumber;
}

export interface InitializeLoanSignature {
    v: number;
    r: Buffer;
    s: Buffer;
    extraData: string;
}

export interface Borrower {
    borrower: string;
    callbackData: BytesLike;
}