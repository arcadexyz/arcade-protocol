import { BigNumber, BigNumberish } from "ethers";

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

export interface ItemsPredicate {
    data: string;
    verifier: string;
}

export interface LoanTerms {
    durationSecs: BigNumberish;
    principal: BigNumber;
    interestRate: BigNumber;
    collateralAddress: string;
    collateralId: BigNumberish;
    payableCurrency: string;
    numInstallments: BigNumberish;
    deadline: BigNumberish;
}

export interface ItemsPayload {
    durationSecs: BigNumberish;
    principal: BigNumber;
    interestRate: BigNumber;
    collateralAddress: string;
    itemsHash: string;
    payableCurrency: string;
    numInstallments: BigNumberish;
    nonce: BigNumberish;
    side: 0 | 1;
    deadline: BigNumberish;
}

export interface LoanData {
    terms: LoanTerms;
    state: LoanState;
    startDate: BigNumberish;
    balance: BigNumber;
    balancePaid: BigNumber;
    lateFeesAccrued: BigNumber;
}
