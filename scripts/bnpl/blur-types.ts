import { BigNumber, BigNumberish, BytesLike } from "ethers";

export interface FeeRate {
    recipient: string;
    rate: BigNumberish;
}

export interface Order {
    trader: string;
    collection: string;
    listingsRoot: BytesLike;
    numberOfListings: BigNumberish;
    expirationTime: BigNumberish;
    assetType: 0 | 1;
    makerFee: FeeRate;
    salt: BigNumberish;
}

export interface Listing {
    index: BigNumberish;
    tokenId: BigNumberish;
    amount: BigNumberish;
    price: BigNumber;
}
export interface Taker {
    tokenId: BigNumberish;
    amount: BigNumberish;
}

export interface Exchange {
    index: BigNumberish;
    proof: BytesLike[];
    listing: Listing;
    taker: Taker;
}

export interface TakeAskSingle {
    order: Order;
    exchange: Exchange;
    takerFee: FeeRate;
    signature: BytesLike;
    tokenRecipient: string;
}

export interface TakeAsk {
    orders: Order[];
    exchanges: Exchange[];
    takerFee: FeeRate;
    signatures: BytesLike;
    tokenRecipient: string;
}