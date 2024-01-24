import { ethers } from "ethers";
import { BigNumber } from "ethers";

export type AdditionalRecipient = {
    amount: BigNumber;
    recipient: string;
};

export type BasicOrderParameters = {
    considerationToken: string;
    considerationIdentifier: BigNumber;
    considerationAmount: BigNumber;
    offerer: string;
    zone: string;
    offerToken: string;
    offerIdentifier: BigNumber;
    offerAmount: BigNumber;
    basicOrderType: number;
    startTime: string | BigNumber | number;
    endTime: string | BigNumber | number;
    zoneHash: string;
    salt: string;
    offererConduitKey: string;
    fulfillerConduitKey: string;
    totalOriginalAdditionalRecipients: BigNumber;
    additionalRecipients: AdditionalRecipient[];
    signature: string;
};

export const encodeBasicOrderSeaportV2 = (item: BasicOrderParameters): string => {
    const types = [
        "tuple(address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,tuple(uint256,address)[],bytes) parameters",
    ];
    const additionalRecipientsArray = item.additionalRecipients.map(e => [e.amount, e.recipient]);
    const values = [
        item.considerationToken, // address
        item.considerationIdentifier, // uint256
        item.considerationAmount, // uint256
        item.offerer, // address
        item.zone, // address
        item.offerToken, // address
        item.offerIdentifier, // uint256
        item.offerAmount, // uint256
        item.basicOrderType, // uint8
        item.startTime, // uint256
        item.endTime, // uint256
        item.zoneHash, // bytes32
        item.salt, // uint256
        item.offererConduitKey, // bytes32
        item.fulfillerConduitKey, // bytes32
        item.totalOriginalAdditionalRecipients, // uint256
        additionalRecipientsArray, // tuple(uint256, address)[]
        item.signature, // bytes
    ];

    return ethers.utils.defaultAbiCoder.encode(types, [values]);
};