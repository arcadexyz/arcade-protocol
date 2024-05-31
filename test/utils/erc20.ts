import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumberish } from "ethers";
import { MockERC20 } from "../../typechain/MockERC20";
import { MockERC20WithDecimals } from "../../typechain";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Mint `amount` tokens for `to`
 */
export const mint = async (token: MockERC20 | MockERC20WithDecimals, to: SignerWithAddress, amount: BigNumberish): Promise<void> => {
    const address = to.address;
    const preBalance = await token.balanceOf(address);

    await expect(token.mint(address, amount)).to.emit(token, "Transfer").withArgs(ZERO_ADDRESS, address, amount);

    const postBalance = await token.balanceOf(address);
    expect(postBalance.sub(preBalance)).to.equal(amount);
};

/**
 * approve `amount` tokens for `to` from `from`
 */
export const approve = async (
    token: MockERC20,
    sender: SignerWithAddress,
    toAddress: string,
    amount: BigNumberish,
): Promise<void> => {
    const senderAddress = sender.address;
    const preApproval = await token.allowance(senderAddress, toAddress);

    await expect(token.connect(sender).approve(toAddress, amount))
        .to.emit(token, "Approval")
        .withArgs(senderAddress, toAddress, amount);

    const postApproval = await token.allowance(senderAddress, toAddress);
    expect(postApproval.sub(preApproval)).to.equal(amount);
};
