import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { Signer, BigNumber } from "ethers";
import { MockERC1155 } from "../../typechain";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Mint tokens for `to`
 */
export const mint = async (token: MockERC1155, to: SignerWithAddress, amount: BigNumber): Promise<string> => {
    const address = to.address;
    return mintToAddress(token, address, amount);
};

/**
 * Mint tokens for `to`
 */
export const mintToAddress = async (token: MockERC1155, to: string, amount: BigNumber): Promise<string> => {
    const tx = await token.mint(to, amount);
    const receipt = await tx.wait();

    if (receipt && receipt.events && receipt.events.length === 1 && receipt.events[0].args) {
        return receipt.events[0].args.id;
    } else {
        throw new Error("Unable to initialize bundle");
    }
};

/**
 * approve `amount` tokens for `to` from `from`
 */
export const approve = async (token: MockERC1155, sender: SignerWithAddress, toAddress: string): Promise<void> => {
    const senderAddress = sender.address;

    await expect(token.connect(sender).setApprovalForAll(toAddress, true))
        .to.emit(token, "ApprovalForAll")
        .withArgs(senderAddress, toAddress, true);
};
