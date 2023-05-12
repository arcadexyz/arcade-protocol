import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { Signer, BigNumber } from "ethers";
import { MockERC721 } from "../../typechain/MockERC721";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Mint a token for `to`
 */
export const mint = async (token: MockERC721, to: SignerWithAddress): Promise<BigNumber> => {
    return mintToAddress(token, to.address);
};

/**
 * Mint a token for `to`
 */
export const mintToAddress = async (token: MockERC721, to: string): Promise<BigNumber> => {
    const tx = await token.mint(to);
    const receipt = await tx.wait();

    if (receipt && receipt.events && receipt.events.length === 1 && receipt.events[0].args) {
        return receipt.events[0].args.tokenId;
    } else {
        throw new Error("Unable to initialize bundle");
    }
};

/**
 * approve `amount` tokens for `to` from `from`
 */
export const approve = async (
    token: MockERC721,
    sender: SignerWithAddress,
    toAddress: string,
    tokenId: BigNumber,
): Promise<void> => {
    const senderAddress = sender.address;
    expect(await token.getApproved(tokenId)).to.not.equal(toAddress);

    await expect(token.connect(sender).approve(toAddress, tokenId))
        .to.emit(token, "Approval")
        .withArgs(senderAddress, toAddress, tokenId);

    expect(await token.getApproved(tokenId)).to.equal(toAddress);
};
