import { expect } from "chai";
import hre, { ethers, waffle } from "hardhat";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber, BigNumberish } from "ethers";

import {
    AssetVault,
    CallWhitelist,
    VaultFactory,
    MockCallDelegator,
    MockERC20,
    MockERC721,
    MockERC1155,
    CryptoPunksMarket,
    DelegationRegistry,
    FeeController,
    BaseURIDescriptor,
} from "../typechain";
import { mint } from "./utils/erc20";
import { mintToAddress as mintERC721 } from "./utils/erc721";
import { mint as mintERC1155 } from "./utils/erc1155";
import { deploy } from "./utils/contracts";
import { BASE_URI } from "./utils/constants";
import { LogDescription } from "ethers/lib/utils";

type Signer = SignerWithAddress;

interface TestContext {
    registry: DelegationRegistry;
    vault: AssetVault;
    vaultTemplate: AssetVault;
    nft: VaultFactory;
    whitelist: CallWhitelist;
    bundleId: BigNumberish;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    mockERC1155: MockERC1155;
    punks: CryptoPunksMarket;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

describe("AssetVault", () => {
    /**
     * Creates a vault instance using the vault factory
     */
    const createVault = async (factory: VaultFactory, user: Signer): Promise<AssetVault> => {
        const tx = await factory.connect(user).initializeBundle(user.address);
        const receipt = await tx.wait();

        let vault: AssetVault | undefined;
        if (receipt && receipt.events) {
            for (const event of receipt.events) {
                if (event.args && event.args.vault) {
                    vault = <AssetVault>await hre.ethers.getContractAt("AssetVault", event.args.vault);
                }
            }
        } else {
            throw new Error("Unable to create new vault");
        }
        if (!vault) {
            throw new Error("Unable to create new vault");
        }
        return vault;
    };

    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await hre.ethers.getSigners();
        const registry = <DelegationRegistry>await deploy("DelegationRegistry", signers[0], []);
        const whitelist = <CallWhitelist>await deploy("CallWhitelistAllExtensions", signers[0], [registry.address]);
        const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);
        const mockERC721 = <MockERC721>await deploy("MockERC721", signers[0], ["Mock ERC721", "MOCK"]);
        const mockERC1155 = <MockERC1155>await deploy("MockERC1155", signers[0], []);

        const vaultTemplate = <AssetVault>await deploy("AssetVault", signers[0], []);
        const feeController = <FeeController>await deploy("FeeController", signers[0], []);
        const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI]);
        const factory = <VaultFactory>(
            await deploy("VaultFactory", signers[0], [
                vaultTemplate.address,
                whitelist.address,
                feeController.address,
                descriptor.address,
            ])
        );
        const vault = await createVault(factory, signers[0]);

        const punks = <CryptoPunksMarket>await deploy("CryptoPunksMarket", signers[0], []);

        return {
            registry,
            nft: factory,
            vault,
            vaultTemplate,
            whitelist,
            bundleId: vault.address,
            mockERC20,
            mockERC721,
            mockERC1155,
            user: signers[0],
            other: signers[1],
            signers: signers.slice(2),
            punks,
        };
    };

    describe("Deployment", () => {
        it("should fail to initialize if deployed as a standalone (not by factory)", async () => {
            const { user, whitelist } = await loadFixture(fixture);

            const vault = <AssetVault>await deploy("AssetVault", user, []);

            await expect(vault.initialize(whitelist.address)).to.be.revertedWith("AV_AlreadyInitialized");
        });

        it("should deploy and set an ownership token", async () => {
            const { user } = await loadFixture(fixture);

            const vault = <AssetVault>await deploy("AssetVault", user, []);

            const txid = vault.deployTransaction.hash;
            const receipt = await ethers.provider.getTransactionReceipt(txid);
            const events = receipt.logs.map((log: { topics: string[]; data: string; }) => vault.interface.parseLog(log));

            const ownershipTokenSetEvent = events.find((e: LogDescription) => e.name === "SetOwnershipToken");
            expect(ownershipTokenSetEvent).to.not.be.undefined;
        });
    });

    describe("Initialize Bundle", () => {
        it("should successfully initialize a bundle", async () => {
            const { nft, user } = await loadFixture(fixture);

            const vault = await createVault(nft, user);
            expect(await vault.ownershipToken()).to.equal(nft.address);
            expect(await vault.withdrawEnabled()).to.equal(false);
        });

        it("should initialize multiple bundles with unique ids", async () => {
            const { nft, user } = await loadFixture(fixture);

            const bundleIds = new Set();
            const size = 25;

            for (let i = 0; i < size; i++) {
                const vault = await createVault(nft, user);
                bundleIds.add(vault.address);
            }

            expect(bundleIds.size).to.equal(size);
        });
    });

    describe("Deposit", () => {
        describe("ERC20", () => {
            it("should accept deposit from an ERC20 token", async () => {
                const { vault, mockERC20, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseUnits("50", 18);

                await mint(mockERC20, user, amount);
                // just directly send ERC20 tokens in
                await mockERC20.connect(user).transfer(vault.address, amount);

                expect(await mockERC20.balanceOf(vault.address)).to.equal(amount);
            });

            it("should accept multiple deposits from an ERC20 token", async () => {
                const { vault, mockERC20, user } = await loadFixture(fixture);
                const baseAmount = hre.ethers.utils.parseUnits("10", 18);
                let amount = hre.ethers.utils.parseUnits("0", 18);

                for (let i = 0; i < 10; i++) {
                    amount = amount.add(baseAmount);

                    await mint(mockERC20, user, baseAmount);
                    await mockERC20.connect(user).transfer(vault.address, baseAmount);

                    expect(await mockERC20.balanceOf(vault.address)).to.equal(amount);
                }
            });

            it("should accept deposits from multiple ERC20 tokens", async () => {
                const { vault, user } = await loadFixture(fixture);
                const baseAmount = hre.ethers.utils.parseUnits("10", 18);

                for (let i = 0; i < 10; i++) {
                    const mockERC20 = <MockERC20>await deploy("MockERC20", user, ["Mock ERC20", "MOCK" + i]);
                    const amount = baseAmount.mul(i);

                    await mint(mockERC20, user, amount);
                    await mockERC20.connect(user).transfer(vault.address, amount);

                    expect(await mockERC20.balanceOf(vault.address)).to.equal(amount);
                }
            });
        });

        describe("ERC721", () => {
            it("should accept deposit from an ERC721 token", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);

                const tokenId = await mintERC721(mockERC721, user.address);
                await mockERC721.transferFrom(user.address, vault.address, tokenId);

                expect(await mockERC721.ownerOf(tokenId)).to.equal(vault.address);
            });

            it("should accept multiple deposits from an ERC721 token", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);

                for (let i = 0; i < 10; i++) {
                    const tokenId = await mintERC721(mockERC721, user.address);
                    await mockERC721.transferFrom(user.address, vault.address, tokenId);

                    expect(await mockERC721.ownerOf(tokenId)).to.equal(vault.address);
                }
            });

            it("should accept deposits from multiple ERC721 tokens", async () => {
                const { vault, user } = await loadFixture(fixture);

                for (let i = 0; i < 10; i++) {
                    const mockERC721 = <MockERC721>await deploy("MockERC721", user, ["Mock ERC721", "MOCK" + i]);
                    const tokenId = await mintERC721(mockERC721, user.address);
                    await mockERC721.transferFrom(user.address, vault.address, tokenId);

                    expect(await mockERC721.ownerOf(tokenId)).to.equal(vault.address);
                }
            });
        });

        describe("ERC1155", () => {
            it("should accept deposit from an ERC1155 NFT", async () => {
                const { vault, mockERC1155, user } = await loadFixture(fixture);
                const amount = BigNumber.from("1");

                const tokenId = await mintERC1155(mockERC1155, user, amount);
                await mockERC1155.safeTransferFrom(user.address, vault.address, tokenId, amount, "0x");

                expect(await mockERC1155.balanceOf(vault.address, tokenId)).to.equal(amount);
            });

            it("should accept deposit from an ERC1155 fungible token", async () => {
                const { vault, mockERC1155, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseEther("10");

                const tokenId = await mintERC1155(mockERC1155, user, amount);
                await mockERC1155.safeTransferFrom(user.address, vault.address, tokenId, amount, "0x");

                expect(await mockERC1155.balanceOf(vault.address, tokenId)).to.equal(amount);
            });

            it("should accept multiple deposits from an ERC1155 token", async () => {
                const { vault, mockERC1155, user } = await loadFixture(fixture);
                const amount = BigNumber.from("1");

                for (let i = 0; i < 10; i++) {
                    const tokenId = await mintERC1155(mockERC1155, user, amount);
                    await mockERC1155.safeTransferFrom(user.address, vault.address, tokenId, amount, "0x");

                    expect(await mockERC1155.balanceOf(vault.address, tokenId)).to.equal(amount);
                }
            });

            it("should accept deposits from multiple ERC1155 tokens", async () => {
                const { vault, user } = await loadFixture(fixture);
                const amount = BigNumber.from("1");

                for (let i = 0; i < 10; i++) {
                    const mockERC1155 = <MockERC1155>await deploy("MockERC1155", user, []);

                    const tokenId = await mintERC1155(mockERC1155, user, amount);
                    await mockERC1155.safeTransferFrom(user.address, vault.address, tokenId, amount, "0x");

                    expect(await mockERC1155.balanceOf(vault.address, tokenId)).to.equal(amount);
                }
            });
        });

        describe("ETH", () => {
            it("should accept deposit of ETH", async () => {
                const { vault, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseEther("50");

                await user.sendTransaction({
                    to: vault.address,
                    value: amount,
                });

                expect(await vault.provider.getBalance(vault.address)).to.equal(amount);
            });

            it("should accept multiple deposits of ETH", async () => {
                const { vault, user } = await loadFixture(fixture);

                let total = BigNumber.from(0);
                for (let i = 1; i <= 10; i++) {
                    const amount = hre.ethers.utils.parseEther(i.toString());
                    await user.sendTransaction({
                        to: vault.address,
                        value: amount,
                    });
                    total = total.add(amount);
                }

                const holdings = await vault.provider.getBalance(vault.address);
                expect(holdings).to.equal(total);
            });
        });
    });

    describe("enableWithdraw", () => {
        it("should close the vault", async () => {
            const { vault, user } = await loadFixture(fixture);
            expect(await vault.withdrawEnabled()).to.equal(false);
            await expect(vault.enableWithdraw()).to.emit(vault, "WithdrawEnabled").withArgs(user.address);

            expect(await vault.withdrawEnabled()).to.equal(true);
        });

        it("should fail to close the vault by non-owner", async () => {
            const { vault, other } = await loadFixture(fixture);
            expect(await vault.withdrawEnabled()).to.equal(false);
            await expect(vault.connect(other).enableWithdraw()).to.be.revertedWith("OERC721_CallerNotOwner");

            expect(await vault.withdrawEnabled()).to.equal(false);
        });
    });

    describe("call", async () => {
        it("succeeds if current owner and on whitelist", async () => {
            const { whitelist, vault, mockERC20, user } = await loadFixture(fixture);

            const selector = mockERC20.interface.getSighash("mint");
            const mintData = await mockERC20.populateTransaction.mint(user.address, ethers.utils.parseEther("1"));
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            await whitelist.add(mockERC20.address, selector);

            const startingBalance = await mockERC20.balanceOf(user.address);
            await expect(vault.connect(user).call(mockERC20.address, mintData.data))
                .to.emit(vault, "Call")
                .withArgs(user.address, mockERC20.address, mintData.data);
            const endingBalance = await mockERC20.balanceOf(user.address);
            expect(endingBalance.sub(startingBalance)).to.equal(ethers.utils.parseEther("1"));
        });

        it("succeeds if delegated and on whitelist", async () => {
            const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(true);

            const selector = mockERC20.interface.getSighash("mint");
            const mintData = await mockERC20.populateTransaction.mint(user.address, ethers.utils.parseEther("1"));
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            // transfer the NFT to the call delegator (like using it as loan collateral)
            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);
            await whitelist.add(mockERC20.address, selector);

            const startingBalance = await mockERC20.balanceOf(user.address);
            await expect(vault.connect(user).call(mockERC20.address, mintData.data))
                .to.emit(vault, "Call")
                .withArgs(user.address, mockERC20.address, mintData.data);
            const endingBalance = await mockERC20.balanceOf(user.address);
            expect(endingBalance.sub(startingBalance)).to.equal(ethers.utils.parseEther("1"));
        });

        it("fails if withdraw enabled on vault", async () => {
            const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(true);

            const selector = mockERC20.interface.getSighash("mint");
            const mintData = await mockERC20.populateTransaction.mint(user.address, ethers.utils.parseEther("1"));
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            await whitelist.add(mockERC20.address, selector);

            // enable withdraw on the vault
            await vault.connect(user).enableWithdraw();

            await expect(vault.connect(user).call(mockERC20.address, mintData.data)).to.be.revertedWith(
                "AV_WithdrawsEnabled",
            );
        });

        it("fails if delegator disallows", async () => {
            const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(false);

            const selector = mockERC20.interface.getSighash("mint");
            const mintData = await mockERC20.populateTransaction.mint(user.address, ethers.utils.parseEther("1"));
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            // transfer the NFT to the call delegator (like using it as loan collateral)
            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);
            await whitelist.add(mockERC20.address, selector);

            await expect(vault.connect(user).call(mockERC20.address, mintData.data)).to.be.revertedWith(
                "AV_MissingAuthorization",
            );
        });

        it("fails if delegator is EOA", async () => {
            const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(true);

            const selector = mockERC20.interface.getSighash("mint(address,uint256)");

            const mintData = await mockERC20.populateTransaction.mint(user.address, ethers.utils.parseEther("1"));
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            // transfer the vault NFT to the call delegator (like using it as loan collateral)
            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await whitelist.add(user.address, selector);

            await expect(vault.connect(user).call(user.address, mintData.data)).to.be.revertedWith(
                "Address: call to non-contract",
            );
        });

        it("fails if delegator is contract which doesn't support interface", async () => {
            const { nft, whitelist, vault, mockERC20, user } = await loadFixture(fixture);

            const selector = mockERC20.interface.getSighash("mint");
            const mintData = await mockERC20.populateTransaction.mint(user.address, ethers.utils.parseEther("1"));
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            // transfer the NFT to the call delegator (like using it as loan collateral)
            await nft.transferFrom(user.address, mockERC20.address, vault.address);
            await whitelist.add(mockERC20.address, selector);

            await expect(vault.connect(user).call(mockERC20.address, mintData.data)).to.be.revertedWith(
                "Transaction reverted: function selector was not recognized and there's no fallback function",
            );
        });

        it("fails from current owner if not whitelisted", async () => {
            const { vault, mockERC20, user } = await loadFixture(fixture);

            const mintData = await mockERC20.populateTransaction.mint(user.address, ethers.utils.parseEther("1"));
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            await expect(vault.connect(user).call(mockERC20.address, mintData.data)).to.be.revertedWith(
                "AV_NonWhitelistedCall",
            );
        });

        it("fails if delegated and not whitelisted", async () => {
            const { nft, vault, mockERC20, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(true);

            const mintData = await mockERC20.populateTransaction.mint(user.address, ethers.utils.parseEther("1"));
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await expect(vault.connect(user).call(mockERC20.address, mintData.data)).to.be.revertedWith(
                "AV_NonWhitelistedCall",
            );
        });

        it("fails if on global blacklist", async () => {
            const { vault, mockERC20, user } = await loadFixture(fixture);

            const transferData = await mockERC20.populateTransaction.transfer(
                user.address,
                ethers.utils.parseEther("1"),
            );
            if (!transferData || !transferData.data) throw new Error("Populate transaction failed");

            await expect(vault.connect(user).call(mockERC20.address, transferData.data)).to.be.revertedWith(
                "AV_NonWhitelistedCall",
            );
        });

        it("fails if on global blacklist even after whitelisting", async () => {
            const { whitelist, vault, mockERC20, user } = await loadFixture(fixture);

            const selector = mockERC20.interface.getSighash("transfer");
            const transferData = await mockERC20.populateTransaction.transfer(
                user.address,
                ethers.utils.parseEther("1"),
            );
            if (!transferData || !transferData.data) throw new Error("Populate transaction failed");

            await whitelist.add(mockERC20.address, selector);

            await expect(vault.connect(user).call(mockERC20.address, transferData.data)).to.be.revertedWith(
                "AV_NonWhitelistedCall",
            );
        });

        it("fails if address is on the whitelist but selector is not", async () => {
            const { whitelist, vault, mockERC721, user } = await loadFixture(fixture);

            const selector = mockERC721.interface.getSighash("burn");
            const mintData = await mockERC721.populateTransaction.mint(user.address);
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            await whitelist.add(mockERC721.address, selector);

            await expect(vault.connect(user).call(mockERC721.address, mintData.data)).to.be.revertedWith(
                "AV_NonWhitelistedCall",
            );
        });

        it("fails if selector is on the whitelist but address is not", async () => {
            const { whitelist, vault, mockERC20, mockERC1155, user } = await loadFixture(fixture);

            const selector = mockERC20.interface.getSighash("mint");
            const mintData = await mockERC1155.populateTransaction.mint(user.address, ethers.utils.parseEther("1"));
            if (!mintData || !mintData.data) throw new Error("Populate transaction failed");

            await whitelist.add(mockERC20.address, selector);

            await expect(vault.connect(user).call(mockERC1155.address, mintData.data)).to.be.revertedWith(
                "AV_NonWhitelistedCall",
            );
        });
    });

    describe("token allowances", () => {
        describe("callApprove", () => {
            it("succeeds if current owner and on whitelist", async () => {
                const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(vault.connect(user).callApprove(mockERC20.address, other.address, amount))
                    .to.emit(vault, "Approve")
                    .withArgs(user.address, mockERC20.address, other.address, amount);

                expect(await mockERC20.allowance(vault.address, other.address)).to.eq(amount);
            });

            it("succeeds if delegated and on whitelist", async () => {
                const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(true);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(vault.connect(user).callApprove(mockERC20.address, other.address, amount))
                    .to.emit(vault, "Approve")
                    .withArgs(user.address, mockERC20.address, other.address, amount);

                expect(await mockERC20.allowance(vault.address, other.address)).to.eq(amount);
            });

            it("fails if withdraw enabled on vault", async () => {
                const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, other.address, true);

                // enable withdraw on the vault
                await vault.connect(user).enableWithdraw();

                await expect(
                    vault.connect(user).callApprove(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_WithdrawsEnabled");
            });

            it("fails if delegator disallows", async () => {
                const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(false);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(
                    vault.connect(user).callApprove(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_MissingAuthorization");
            });

            it("fails if delegator is EOA", async () => {
                const { nft, whitelist, vault, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(true);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await whitelist.setApproval(user.address, other.address, true);

                await expect(vault.connect(user).callApprove(user.address, other.address, amount)).to.be.revertedWith(
                    "Transaction reverted: function returned an unexpected amount of data",
                );
            });

            it("fails if delegator is contract which doesn't support interface", async () => {
                const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(false);

                // transfer the NFT to the call delegator (like using it as loan collateral)
                await nft.transferFrom(user.address, mockERC20.address, vault.address);

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(
                    vault.connect(user).callApprove(mockERC20.address, other.address, amount),
                ).to.be.revertedWith(
                    "Transaction reverted: function selector was not recognized and there's no fallback function",
                );
            });

            it("fails from current owner if not whitelisted", async () => {
                const { vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await expect(
                    vault.connect(user).callApprove(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });

            it("fails if delegated and not whitelisted", async () => {
                const { nft, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(true);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await expect(
                    vault.connect(user).callApprove(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });

            it("fails if token is on the whitelist but spender is not", async () => {
                const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, user.address, true);

                await expect(
                    vault.connect(user).callApprove(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });

            it("fails if spender is on the whitelist but token is not", async () => {
                const { whitelist, vault, mockERC20, mockERC1155, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(
                    vault.connect(user).callApprove(mockERC1155.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });
        });

        describe("increaseAllowance", () => {
            it("succeeds if current owner and on whitelist", async () => {
                const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount))
                    .to.emit(vault, "IncreaseAllowance")
                    .withArgs(user.address, mockERC20.address, other.address, amount);

                expect(await mockERC20.allowance(vault.address, other.address)).to.eq(amount);
            });

            it("succeeds if delegated and on whitelist", async () => {
                const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(true);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount))
                    .to.emit(vault, "IncreaseAllowance")
                    .withArgs(user.address, mockERC20.address, other.address, amount);

                expect(await mockERC20.allowance(vault.address, other.address)).to.eq(amount);
            });

            it("fails if withdraw enabled on vault", async () => {
                const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, other.address, true);

                // enable withdraw on the vault
                await vault.connect(user).enableWithdraw();

                await expect(
                    vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_WithdrawsEnabled");
            });

            it("fails if delegator disallows", async () => {
                const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(false);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(
                    vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_MissingAuthorization");
            });

            it("fails if delegator is EOA", async () => {
                const { nft, whitelist, vault, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(true);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await whitelist.setApproval(user.address, other.address, true);

                await expect(
                    vault.connect(user).callIncreaseAllowance(user.address, other.address, amount),
                ).to.be.revertedWith("Transaction reverted: function returned an unexpected amount of data");
            });

            it("fails if delegator is contract which doesn't support interface", async () => {
                const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(false);

                // transfer the NFT to the call delegator (like using it as loan collateral)
                await nft.transferFrom(user.address, mockERC20.address, vault.address);

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(
                    vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith(
                    "Transaction reverted: function selector was not recognized and there's no fallback function",
                );
            });

            it("fails from current owner if not whitelisted", async () => {
                const { vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await expect(
                    vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });

            it("fails if delegated and not whitelisted", async () => {
                const { nft, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(true);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await expect(
                    vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });

            it("fails if token is on the whitelist but spender is not", async () => {
                const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, user.address, true);

                await expect(
                    vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });

            it("fails if spender is on the whitelist but token is not", async () => {
                const { whitelist, vault, mockERC20, mockERC1155, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(
                    vault.connect(user).callIncreaseAllowance(mockERC1155.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });
        });

        describe("decreaseAllowance", () => {
            it("succeeds if current owner and on whitelist", async () => {
                const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount))
                    .to.emit(vault, "IncreaseAllowance")
                    .withArgs(user.address, mockERC20.address, other.address, amount);

                await expect(vault.connect(user).callDecreaseAllowance(mockERC20.address, other.address, amount))
                    .to.emit(vault, "DecreaseAllowance")
                    .withArgs(user.address, mockERC20.address, other.address, amount);

                expect(await mockERC20.allowance(vault.address, other.address)).to.eq(0);
            });

            it("succeeds if delegated and on whitelist", async () => {
                const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(true);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(vault.connect(user).callIncreaseAllowance(mockERC20.address, other.address, amount))
                    .to.emit(vault, "IncreaseAllowance")
                    .withArgs(user.address, mockERC20.address, other.address, amount);

                await expect(vault.connect(user).callDecreaseAllowance(mockERC20.address, other.address, amount))
                    .to.emit(vault, "DecreaseAllowance")
                    .withArgs(user.address, mockERC20.address, other.address, amount);

                expect(await mockERC20.allowance(vault.address, other.address)).to.eq(0);
            });

            it("fails if withdraw enabled on vault", async () => {
                const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, other.address, true);

                // enable withdraw on the vault
                await vault.connect(user).enableWithdraw();

                await expect(
                    vault.connect(user).callDecreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_WithdrawsEnabled");
            });

            it("fails if delegator disallows", async () => {
                const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(false);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(
                    vault.connect(user).callDecreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_MissingAuthorization");
            });

            it("fails if delegator is EOA", async () => {
                const { nft, whitelist, vault, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(true);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await whitelist.setApproval(user.address, other.address, true);

                await expect(
                    vault.connect(user).callDecreaseAllowance(user.address, other.address, amount),
                ).to.be.revertedWith("Transaction reverted: function returned an unexpected amount of data");
            });

            it("fails if delegator is contract which doesn't support interface", async () => {
                const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(false);

                // transfer the NFT to the call delegator (like using it as loan collateral)
                await nft.transferFrom(user.address, mockERC20.address, vault.address);

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(
                    vault.connect(user).callDecreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith(
                    "Transaction reverted: function selector was not recognized and there's no fallback function",
                );
            });

            it("fails from current owner if not whitelisted", async () => {
                const { vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await expect(
                    vault.connect(user).callDecreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });

            it("fails if delegated and not whitelisted", async () => {
                const { nft, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
                await mockCallDelegator.connect(other).setCanCall(true);

                await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

                await expect(
                    vault.connect(user).callDecreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });

            it("fails if token is on the whitelist but spender is not", async () => {
                const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, user.address, true);

                await expect(
                    vault.connect(user).callDecreaseAllowance(mockERC20.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });

            it("fails if spender is on the whitelist but token is not", async () => {
                const { whitelist, vault, mockERC20, mockERC1155, user, other } = await loadFixture(fixture);
                const amount = ethers.utils.parseEther("10");

                await whitelist.setApproval(mockERC20.address, other.address, true);

                await expect(
                    vault.connect(user).callDecreaseAllowance(mockERC1155.address, other.address, amount),
                ).to.be.revertedWith("AV_NonWhitelistedApproval");
            });
        });
    });

    describe("callDelegateForContract", () => {
        it("enables delegation if current owner and on whitelist", async () => {
            const { registry, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            await whitelist.setDelegationApproval(mockERC20.address, true);

            await expect(vault.connect(user).callDelegateForContract(mockERC20.address, other.address, true))
                .to.emit(vault, "DelegateContract")
                .withArgs(user.address, mockERC20.address, other.address, true);

            const delegates = await registry.getDelegatesForContract(vault.address, mockERC20.address);
            expect(delegates.length).to.eq(1);
            expect(delegates[0]).to.eq(other.address);
        });

        it("disables delegation if current owner and on whitelist", async () => {
            const { registry, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            await whitelist.setDelegationApproval(mockERC20.address, true);

            await expect(vault.connect(user).callDelegateForContract(mockERC20.address, other.address, true))
                .to.emit(vault, "DelegateContract")
                .withArgs(user.address, mockERC20.address, other.address, true);

            let delegates = await registry.getDelegatesForContract(vault.address, mockERC20.address);
            expect(delegates.length).to.eq(1);
            expect(delegates[0]).to.eq(other.address);

            await expect(vault.connect(user).callDelegateForContract(mockERC20.address, other.address, false))
                .to.emit(vault, "DelegateContract")
                .withArgs(user.address, mockERC20.address, other.address, false);

            delegates = await registry.getDelegatesForContract(vault.address, mockERC20.address);
            expect(delegates.length).to.eq(0);
        });

        it("succeeds if delegated and on whitelist", async () => {
            const { registry, nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(true);

            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await whitelist.setDelegationApproval(mockERC20.address, true);

            await expect(vault.connect(user).callDelegateForContract(mockERC20.address, other.address, true))
                .to.emit(vault, "DelegateContract")
                .withArgs(user.address, mockERC20.address, other.address, true);

            const delegates = await registry.getDelegatesForContract(vault.address, mockERC20.address);
            expect(delegates.length).to.eq(1);
            expect(delegates[0]).to.eq(other.address);
        });

        it("fails if withdraw enabled on vault", async () => {
            const { whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            await whitelist.setDelegationApproval(mockERC20.address, true);

            // enable withdraw on the vault
            await vault.connect(user).enableWithdraw();

            await expect(
                vault.connect(user).callDelegateForContract(mockERC20.address, other.address, true),
            ).to.be.revertedWith("AV_WithdrawsEnabled");
        });

        it("fails if delegator disallows", async () => {
            const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(false);

            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await whitelist.setDelegationApproval(mockERC20.address, true);

            await expect(
                vault.connect(user).callDelegateForContract(mockERC20.address, other.address, true),
            ).to.be.revertedWith("AV_MissingAuthorization");
        });

        it("fails if delegator is contract which doesn't support interface", async () => {
            const { nft, whitelist, vault, mockERC20, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(false);

            await nft.transferFrom(user.address, mockERC20.address, vault.address);

            await whitelist.setDelegationApproval(mockERC20.address, true);

            await expect(
                vault.connect(user).callDelegateForContract(mockERC20.address, other.address, true),
            ).to.be.revertedWith(
                "Transaction reverted: function selector was not recognized and there's no fallback function",
            );
        });

        it("fails from current owner if not whitelisted", async () => {
            const { vault, mockERC20, user, other } = await loadFixture(fixture);

            await expect(
                vault.connect(user).callDelegateForContract(mockERC20.address, other.address, true),
            ).to.be.revertedWith("AV_NonWhitelistedDelegation");
        });

        it("fails if delegated and not whitelisted", async () => {
            const { nft, vault, mockERC20, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(true);

            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await expect(
                vault.connect(user).callDelegateForContract(mockERC20.address, other.address, true),
            ).to.be.revertedWith("AV_NonWhitelistedDelegation");
        });
    });

    describe("callDelegateForToken", () => {
        it("enables delegation if current owner and on whitelist", async () => {
            const { registry, whitelist, vault, mockERC721, user, other } = await loadFixture(fixture);

            await whitelist.setDelegationApproval(mockERC721.address, true);
            const tokenId = await mintERC721(mockERC721, vault.address);

            // Mint a second one, should have no delegates
            const tokenId2 = await mintERC721(mockERC721, vault.address);

            await expect(vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, true))
                .to.emit(vault, "DelegateToken")
                .withArgs(user.address, mockERC721.address, other.address, tokenId, true);

            let delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId);
            expect(delegates.length).to.eq(1);
            expect(delegates[0]).to.eq(other.address);

            delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId2);
            expect(delegates.length).to.eq(0);
        });

        it("disables delegation if current owner and on whitelist", async () => {
            const { registry, whitelist, vault, mockERC721, user, other } = await loadFixture(fixture);

            await whitelist.setDelegationApproval(mockERC721.address, true);
            const tokenId = await mintERC721(mockERC721, vault.address);

            await expect(vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, true))
                .to.emit(vault, "DelegateToken")
                .withArgs(user.address, mockERC721.address, other.address, tokenId, true);

            let delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId);
            expect(delegates.length).to.eq(1);
            expect(delegates[0]).to.eq(other.address);

            await expect(vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, false))
                .to.emit(vault, "DelegateToken")
                .withArgs(user.address, mockERC721.address, other.address, tokenId, false);

            delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId);
            expect(delegates.length).to.eq(0);
        });

        it("succeeds if delegated and on whitelist", async () => {
            const { registry, nft, whitelist, vault, mockERC721, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(true);

            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await whitelist.setDelegationApproval(mockERC721.address, true);
            const tokenId = await mintERC721(mockERC721, vault.address);

            await expect(vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, true))
                .to.emit(vault, "DelegateToken")
                .withArgs(user.address, mockERC721.address, other.address, tokenId, true);

            const delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId);
            expect(delegates.length).to.eq(1);
            expect(delegates[0]).to.eq(other.address);
        });

        it("fails if withdraw enabled on vault", async () => {
            const { whitelist, vault, mockERC721, user, other } = await loadFixture(fixture);

            await whitelist.setDelegationApproval(mockERC721.address, true);
            const tokenId = await mintERC721(mockERC721, vault.address);

            // enable withdraw on the vault
            await vault.connect(user).enableWithdraw();

            await expect(
                vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, true),
            ).to.be.revertedWith("AV_WithdrawsEnabled");
        });

        it("fails if delegator disallows", async () => {
            const { nft, whitelist, vault, mockERC721, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(false);

            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await whitelist.setDelegationApproval(mockERC721.address, true);
            const tokenId = await mintERC721(mockERC721, vault.address);

            await expect(
                vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, true),
            ).to.be.revertedWith("AV_MissingAuthorization");
        });

        it("fails if delegator is contract which doesn't support interface", async () => {
            const { nft, whitelist, vault, mockERC721, user, other } = await loadFixture(fixture);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(false);

            // transfer the NFT to the call delegator (like using it as loan collateral)
            await nft.transferFrom(user.address, mockERC721.address, vault.address);

            await whitelist.setDelegationApproval(mockERC721.address, true);
            const tokenId = await mintERC721(mockERC721, vault.address);

            await expect(
                vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, true),
            ).to.be.revertedWith(
                "Transaction reverted: function selector was not recognized and there's no fallback function",
            );
        });

        it("fails from current owner if not whitelisted", async () => {
            const { vault, mockERC721, user, other } = await loadFixture(fixture);
            const tokenId = await mintERC721(mockERC721, vault.address);

            await expect(
                vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, true),
            ).to.be.revertedWith("AV_NonWhitelistedDelegation");
        });

        it("fails if delegated and not whitelisted", async () => {
            const { nft, vault, mockERC721, user, other } = await loadFixture(fixture);
            const tokenId = await mintERC721(mockERC721, vault.address);

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(true);

            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await expect(
                vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, true),
            ).to.be.revertedWith("AV_NonWhitelistedDelegation");
        });
    });

    describe("revokeAllDelegates", () => {
        let ctx: TestContext;
        let other2: SignerWithAddress;
        let tokenId: BigNumberish;
        let tokenId2: BigNumberish;

        beforeEach(async () => {
            // Make some delegations
            // Delegate all ERC20 to other
            // Delegate one ERC721 to other, another to other2

            ctx = await loadFixture(fixture);
            const { registry, whitelist, vault, mockERC20, mockERC721, user, other, signers } = ctx;
            other2 = signers[0];

            await whitelist.setDelegationApproval(mockERC20.address, true);
            await whitelist.setDelegationApproval(mockERC721.address, true);

            tokenId = await mintERC721(mockERC721, vault.address);
            tokenId2 = await mintERC721(mockERC721, vault.address);

            await expect(vault.connect(user).callDelegateForContract(mockERC20.address, other.address, true))
                .to.emit(vault, "DelegateContract")
                .withArgs(user.address, mockERC20.address, other.address, true);

            await expect(vault.connect(user).callDelegateForToken(mockERC721.address, other.address, tokenId, true))
                .to.emit(vault, "DelegateToken")
                .withArgs(user.address, mockERC721.address, other.address, tokenId, true);

            await expect(vault.connect(user).callDelegateForToken(mockERC721.address, other2.address, tokenId2, true))
                .to.emit(vault, "DelegateToken")
                .withArgs(user.address, mockERC721.address, other2.address, tokenId2, true);

            let delegates = await registry.getDelegatesForContract(vault.address, mockERC20.address);
            expect(delegates.length).to.eq(1);

            delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId);
            expect(delegates.length).to.eq(1);

            delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId2);
            expect(delegates.length).to.eq(1);
        });

        it("revokes all delegates if current owner", async () => {
            const { vault, registry, user, mockERC20, mockERC721 } = ctx;

            await expect(vault.connect(user).callRevokeAllDelegates())
                .to.emit(vault, "DelegateRevoke")
                .withArgs(user.address);

            let delegates = await registry.getDelegatesForContract(vault.address, mockERC20.address);
            expect(delegates.length).to.eq(0);

            delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId);
            expect(delegates.length).to.eq(0);

            delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId2);
            expect(delegates.length).to.eq(0);
        });

        it("revokes all delegates if delegated to ICallDelegator", async () => {
            const { vault, registry, user, mockERC20, mockERC721, nft, other } = ctx;

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(true);

            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await expect(vault.connect(user).callRevokeAllDelegates())
                .to.emit(vault, "DelegateRevoke")
                .withArgs(user.address);

            let delegates = await registry.getDelegatesForContract(vault.address, mockERC20.address);
            expect(delegates.length).to.eq(0);

            delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId);
            expect(delegates.length).to.eq(0);

            delegates = await registry.getDelegatesForToken(vault.address, mockERC721.address, tokenId2);
            expect(delegates.length).to.eq(0);
        });

        it("fails if withdraw enabled on vault", async () => {
            const { vault, user } = ctx;

            // enable withdraw on the vault
            await vault.connect(user).enableWithdraw();

            await expect(vault.connect(user).callRevokeAllDelegates()).to.be.revertedWith("AV_WithdrawsEnabled");
        });

        it("fails if delegator disallows", async () => {
            const { vault, user, nft, other } = ctx;

            const mockCallDelegator = <MockCallDelegator>await deploy("MockCallDelegator", other, []);
            await mockCallDelegator.connect(other).setCanCall(false);

            await nft.transferFrom(user.address, mockCallDelegator.address, vault.address);

            await expect(vault.connect(user).callRevokeAllDelegates()).to.be.revertedWith("AV_MissingAuthorization");
        });

        it("fails if delegator is contract which doesn't support interface", async () => {
            const { vault, user, nft, mockERC20 } = ctx;

            await nft.transferFrom(user.address, mockERC20.address, vault.address);

            await expect(vault.connect(user).callRevokeAllDelegates()).to.be.revertedWith(
                "Transaction reverted: function selector was not recognized and there's no fallback function",
            );
        });
    });

    describe("Withdraw", () => {
        describe("ERC20", () => {
            /**
             * Set up a withdrawal test by depositing some ERC20s into a bundle
             */
            const deposit = async (token: MockERC20, vault: AssetVault, amount: BigNumber, user: Signer) => {
                await mint(token, user, amount);
                await token.connect(user).transfer(vault.address, amount);
            };

            it("should withdraw single deposit from a bundle", async () => {
                const { vault, mockERC20, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseUnits("50", 18);
                await deposit(mockERC20, vault, amount, user);

                await vault.connect(user).enableWithdraw();
                await expect(vault.connect(user).withdrawERC20(mockERC20.address, user.address))
                    .to.emit(vault, "WithdrawERC20")
                    .withArgs(user.address, mockERC20.address, user.address, amount)
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(vault.address, user.address, amount);
            });

            it("should withdraw single deposit from a bundle after transfer", async () => {
                const { nft, bundleId, vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseUnits("50", 18);
                await deposit(mockERC20, vault, amount, user);
                await nft["safeTransferFrom(address,address,uint256)"](user.address, other.address, bundleId);

                await expect(vault.connect(other).enableWithdraw())
                    .to.emit(vault, "WithdrawEnabled")
                    .withArgs(other.address);
                await expect(vault.connect(other).withdrawERC20(mockERC20.address, other.address))
                    .to.emit(vault, "WithdrawERC20")
                    .withArgs(other.address, mockERC20.address, other.address, amount)
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(bundleId, other.address, amount);
            });

            it("should withdraw multiple deposits of the same token from a bundle", async () => {
                const { vault, mockERC20, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseUnits("50", 18);
                await deposit(mockERC20, vault, amount, user);
                const secondAmount = hre.ethers.utils.parseUnits("14", 18);
                await deposit(mockERC20, vault, secondAmount, user);
                const total = amount.add(secondAmount);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawERC20(mockERC20.address, user.address))
                    .to.emit(vault, "WithdrawERC20")
                    .withArgs(user.address, mockERC20.address, user.address, total)
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(vault.address, user.address, total);
            });

            it("should withdraw deposits of multiple tokens from a bundle", async () => {
                const { vault, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseUnits("50", 18);

                const tokens = [];
                for (let i = 0; i < 10; i++) {
                    const mockERC20 = <MockERC20>await deploy("MockERC20", user, ["Mock ERC20", "MOCK" + i]);
                    await deposit(mockERC20, vault, amount, user);
                    tokens.push(mockERC20);
                }

                await vault.enableWithdraw();
                for (const token of tokens) {
                    await expect(vault.connect(user).withdrawERC20(token.address, user.address))
                        .to.emit(vault, "WithdrawERC20")
                        .withArgs(user.address, token.address, user.address, amount)
                        .to.emit(token, "Transfer")
                        .withArgs(vault.address, user.address, amount);
                }
            });

            it("should fail to withdraw when withdraws disabled", async () => {
                const { vault, mockERC20, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseUnits("50", 18);
                await deposit(mockERC20, vault, amount, user);

                await expect(vault.connect(user).withdrawERC20(mockERC20.address, user.address)).to.be.revertedWith(
                    "AV_WithdrawsDisabled",
                );
            });

            it("should fail to withdraw from non-owner", async () => {
                const { vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseUnits("50", 18);
                await deposit(mockERC20, vault, amount, user);

                await vault.enableWithdraw();
                await expect(vault.connect(other).withdrawERC20(mockERC20.address, user.address)).to.be.revertedWith(
                    "OERC721_CallerNotOwner",
                );
            });

            it("should throw when withdraw called by non-owner", async () => {
                const { vault, mockERC20, user, other } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseUnits("50", 18);
                await deposit(mockERC20, vault, amount, user);

                await expect(vault.connect(other).withdrawERC20(mockERC20.address, user.address)).to.be.revertedWith(
                    "OERC721_CallerNotOwner",
                );
            });

            it("should fail when non-owner calls with approval", async () => {
                const { nft, vault, mockERC20, user, other } = await loadFixture(fixture);

                await nft.connect(user).approve(other.address, vault.address);
                await expect(vault.connect(other).withdrawERC20(mockERC20.address, user.address)).to.be.revertedWith(
                    "OERC721_CallerNotOwner",
                );
            });

            it("should fail when recipient is address zero", async () => {
                const { vault, mockERC20, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseUnits("50", 18);
                await deposit(mockERC20, vault, amount, user);

                await vault.connect(user).enableWithdraw();
                await expect(
                    vault.connect(user).withdrawERC20(mockERC20.address, ethers.constants.AddressZero),
                ).to.be.revertedWith(`AV_ZeroAddress("to")`);
            });
        });

        describe("ERC721", () => {
            /**
             * Set up a withdrawal test by depositing some ERC721s into a bundle
             */
            const deposit = async (token: MockERC721, vault: AssetVault, user: Signer) => {
                const tokenId = await mintERC721(token, user.address);
                await token["safeTransferFrom(address,address,uint256)"](user.address, vault.address, tokenId);
                return tokenId;
            };

            it("should withdraw single deposit from a bundle", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);
                const tokenId = await deposit(mockERC721, vault, user);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawERC721(mockERC721.address, tokenId, user.address))
                    .to.emit(vault, "WithdrawERC721")
                    .withArgs(user.address, mockERC721.address, user.address, tokenId)
                    .to.emit(mockERC721, "Transfer")
                    .withArgs(vault.address, user.address, tokenId);
            });

            it("should withdraw a CryptoPunk from a vault", async () => {
                const { vault, punks, user } = await loadFixture(fixture);
                const punkIndex = 1234;
                // claim ownership of punk
                await punks.setInitialOwner(user.address, punkIndex);
                await punks.allInitialOwnersAssigned();
                // "approve" the punk to the vault
                await punks.offerPunkForSaleToAddress(punkIndex, 0, vault.address);
                // deposit the punk into the vault
                await punks.transferPunk(vault.address, punkIndex);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawPunk(punks.address, punkIndex, user.address))
                    .to.emit(punks, "Transfer")
                    .withArgs(vault.address, user.address, 1)
                    .to.emit(punks, "PunkTransfer")
                    .withArgs(vault.address, user.address, punkIndex);
            });

            it("should fail to withdraw CryptoPunk when recipient is address zero", async () => {
                const { vault, punks, user } = await loadFixture(fixture);
                const punkIndex = 1234;
                // claim ownership of punk
                await punks.setInitialOwner(user.address, punkIndex);
                await punks.allInitialOwnersAssigned();
                // "approve" the punk to the vault
                await punks.offerPunkForSaleToAddress(punkIndex, 0, vault.address);
                // deposit the punk into the vault
                await punks.transferPunk(vault.address, punkIndex);

                await vault.enableWithdraw();
                await expect(
                    vault.connect(user).withdrawPunk(punks.address, punkIndex, ethers.constants.AddressZero),
                ).to.be.revertedWith(`AV_ZeroAddress("to")`);
            });

            it("should throw when already withdrawn", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);
                const tokenId = await deposit(mockERC721, vault, user);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawERC721(mockERC721.address, tokenId, user.address))
                    .to.emit(vault, "WithdrawERC721")
                    .withArgs(user.address, mockERC721.address, user.address, tokenId)
                    .to.emit(mockERC721, "Transfer")
                    .withArgs(vault.address, user.address, tokenId);

                await expect(
                    vault.connect(user).withdrawERC721(mockERC721.address, tokenId, user.address),
                ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
            });

            it("should throw when withdraw called by non-owner", async () => {
                const { vault, mockERC721, user, other } = await loadFixture(fixture);
                const tokenId = await deposit(mockERC721, vault, user);

                await vault.enableWithdraw();
                await expect(
                    vault.connect(other).withdrawERC721(mockERC721.address, tokenId, user.address),
                ).to.be.revertedWith("OERC721_CallerNotOwner");
            });

            it("should fail to withdraw when withdraws disabled", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);
                const tokenId = await deposit(mockERC721, vault, user);

                await expect(
                    vault.connect(user).withdrawERC721(mockERC721.address, tokenId, user.address),
                ).to.be.revertedWith("AV_WithdrawsDisabled");
            });

            it("should fail to withdraw when recipient is zero address", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);
                const tokenId = await deposit(mockERC721, vault, user);

                await vault.enableWithdraw();
                await expect(
                    vault.connect(user).withdrawERC721(mockERC721.address, tokenId, ethers.constants.AddressZero),
                ).to.be.revertedWith(`AV_ZeroAddress("to")`);
            });
        });

        describe("ERC1155", () => {
            /**
             * Set up a withdrawal test by depositing some ERC1155s into a bundle
             */
            const deposit = async (token: MockERC1155, vault: AssetVault, user: Signer, amount: BigNumber) => {
                const tokenId = await mintERC1155(token, user, amount);
                await token.safeTransferFrom(user.address, vault.address, tokenId, amount, "0x");
                return tokenId;
            };

            it("should withdraw single deposit from a bundle", async () => {
                const { vault, mockERC1155, user } = await loadFixture(fixture);
                const amount = BigNumber.from("1");
                const tokenId = await deposit(mockERC1155, vault, user, amount);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawERC1155(mockERC1155.address, tokenId, user.address))
                    .to.emit(vault, "WithdrawERC1155")
                    .withArgs(user.address, mockERC1155.address, user.address, tokenId, amount)
                    .to.emit(mockERC1155, "TransferSingle")
                    .withArgs(vault.address, vault.address, user.address, tokenId, amount);
            });

            it("should withdraw fungible deposit from a bundle", async () => {
                const { vault, mockERC1155, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseEther("100");
                const tokenId = await deposit(mockERC1155, vault, user, amount);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawERC1155(mockERC1155.address, tokenId, user.address))
                    .to.emit(vault, "WithdrawERC1155")
                    .withArgs(user.address, mockERC1155.address, user.address, tokenId, amount)
                    .to.emit(mockERC1155, "TransferSingle")
                    .withArgs(vault.address, vault.address, user.address, tokenId, amount);
            });

            it("should fail to withdraw when withdraws disabled", async () => {
                const { vault, mockERC1155, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseEther("100");
                const tokenId = await deposit(mockERC1155, vault, user, amount);

                await expect(
                    vault.connect(user).withdrawERC1155(mockERC1155.address, tokenId, user.address),
                ).to.be.revertedWith("AV_WithdrawsDisabled");
            });

            it("should throw when withdraw called by non-owner", async () => {
                const { vault, mockERC1155, user, other } = await loadFixture(fixture);
                const amount = BigNumber.from("1");
                const tokenId = await deposit(mockERC1155, vault, user, amount);

                await vault.enableWithdraw();
                await expect(
                    vault.connect(other).withdrawERC1155(mockERC1155.address, tokenId, other.address),
                ).to.be.revertedWith("OERC721_CallerNotOwner");
            });

            it("should fail when recipient is zero address", async () => {
                const { vault, mockERC1155, user } = await loadFixture(fixture);
                const amount = BigNumber.from("1");
                const tokenId = await deposit(mockERC1155, vault, user, amount);

                await vault.enableWithdraw();
                await expect(
                    vault.connect(user).withdrawERC1155(mockERC1155.address, tokenId, ethers.constants.AddressZero),
                ).to.be.revertedWith(`AV_ZeroAddress("to")`);
            });
        });

        describe("Withdraw batch", () => {
            const depositERC1155 = async (token: MockERC1155, vault: AssetVault, user: Signer, amount: BigNumber) => {
                const tokenId = await mintERC1155(token, user, amount);
                await token.safeTransferFrom(user.address, vault.address, tokenId, amount, "0x");
                return tokenId;
            };

            const depositERC721 = async (token: MockERC721, vault: AssetVault, user: Signer) => {
                const tokenId = await mintERC721(token, user.address);
                await token["safeTransferFrom(address,address,uint256)"](user.address, vault.address, tokenId);
                return tokenId;
            };

            it("should withdraw 24 ERC721s and 100 ERC1155s from a bundle", async () => {
                const { vault, mockERC1155, mockERC721, user } = await loadFixture(fixture);

                const amount = BigNumber.from("100");
                const tokenId1155 = await depositERC1155(mockERC1155, vault, user, amount);

                let tokenIds = [];
                for (let i = 0; i < 24; i++) {
                    const tokenId = await depositERC721(mockERC721, vault, user);
                    tokenIds.push(tokenId);
                }

                let tokenTypes = [];
                let tokenAddresses = [];
                for (let i = 0; i < 24; i++) {
                    tokenTypes.push(0);
                    tokenAddresses.push(mockERC721.address);
                }

                tokenTypes.push(1);
                tokenAddresses.push(mockERC1155.address);
                tokenIds.push(tokenId1155);

                const userERC721BalanceBefore = await mockERC721.balanceOf(user.address);
                const userERC1155BalanceBefore = await mockERC1155.balanceOf(user.address, tokenId1155);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawBatch(tokenAddresses, tokenIds, tokenTypes, user.address));

                const userERC721BalanceAfter = await mockERC721.balanceOf(user.address);
                const userERC1155BalanceAfter = await mockERC1155.balanceOf(user.address, tokenId1155);

                expect(userERC721BalanceAfter).to.equal(userERC721BalanceBefore.add(24));
                expect(userERC1155BalanceAfter).to.equal(userERC1155BalanceBefore.add(100));
            });

            it("withdraw 1 ERC721", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);
                const tokenId = await depositERC721(mockERC721, vault, user);

                let tokenAddresses = [];
                let tokenTypes = [];
                let tokenIds = [];
                tokenAddresses.push(mockERC721.address);
                tokenTypes.push(0);
                tokenIds.push(tokenId);

                const userERC721BalanceBefore = await mockERC721.balanceOf(user.address);

                await vault.enableWithdraw();
                await vault.connect(user).withdrawBatch(tokenAddresses, tokenIds, tokenTypes, user.address);

                const userERC721BalanceAfter = await mockERC721.balanceOf(user.address);

                expect(userERC721BalanceAfter).to.equal(userERC721BalanceBefore.add(1));
            });

            it("withdraw ERC1155 with an amount of 100", async () => {
                const { vault, mockERC1155, user } = await loadFixture(fixture);
                const amount = BigNumber.from("100");
                const tokenId = await depositERC1155(mockERC1155, vault, user, amount);

                let tokenAddresses = [];
                let tokenTypes = [];
                let tokenIds = [];
                tokenAddresses.push(mockERC1155.address);
                tokenTypes.push(1);
                tokenIds.push(tokenId);

                const userERC1155BalanceBefore = await mockERC1155.balanceOf(user.address, tokenId);

                await vault.enableWithdraw();
                await vault.connect(user).withdrawBatch(tokenAddresses, tokenIds, tokenTypes, user.address);

                const userERC1155BalanceAfter = await mockERC1155.balanceOf(user.address, tokenId);

                expect(userERC1155BalanceAfter).to.equal(userERC1155BalanceBefore.add(100));
            });

            it("should revert when user specifies over 25 items to withdraw", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);

                let tokenIds = [];
                for (let i = 0; i < 26; i++) {
                    const tokenId = await depositERC721(mockERC721, vault, user);
                    tokenIds.push(tokenId);
                }

                let tokenTypes = [];
                let tokenAddresses = [];
                for (let i = 0; i < 26; i++) {
                    tokenTypes.push(0);
                    tokenAddresses.push(mockERC721.address);
                }

                await vault.enableWithdraw();
                await expect(
                    vault.connect(user).withdrawBatch(tokenAddresses, tokenIds, tokenTypes, user.address),
                ).to.be.revertedWith("AV_TooManyItems(26)");
            });

            it("should revert when user specifies tokenId array length that does not match", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);

                let tokenIds = [];
                for (let i = 0; i < 10; i++) {
                    const tokenId = await depositERC721(mockERC721, vault, user);
                    tokenIds.push(tokenId);
                }

                let tokenTypes = [];
                let tokenAddresses = [];
                for (let i = 0; i < 10; i++) {
                    tokenTypes.push(0);
                    tokenAddresses.push(mockERC721.address);
                }

                tokenIds.pop();

                await vault.enableWithdraw();
                await expect(
                    vault.connect(user).withdrawBatch(tokenAddresses, tokenIds, tokenTypes, user.address),
                ).to.be.revertedWith(`AV_LengthMismatch("tokenId")`);
            });

            it("should revert when user specifies tokenType array length that does not match", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);

                let tokenIds = [];
                for (let i = 0; i < 10; i++) {
                    const tokenId = await depositERC721(mockERC721, vault, user);
                    tokenIds.push(tokenId);
                }

                let tokenTypes = [];
                let tokenAddresses = [];
                for (let i = 0; i < 10; i++) {
                    tokenTypes.push(0);
                    tokenAddresses.push(mockERC721.address);
                }

                tokenTypes.pop();

                await vault.enableWithdraw();
                await expect(
                    vault.connect(user).withdrawBatch(tokenAddresses, tokenIds, tokenTypes, user.address),
                ).to.be.revertedWith(`AV_LengthMismatch("tokenType")`);
            });

            it("should revert when user specifies zero address as receiver", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);
                const tokenId = await depositERC721(mockERC721, vault, user);

                await vault.enableWithdraw();
                await expect(
                    vault
                        .connect(user)
                        .withdrawBatch([mockERC721.address], [tokenId], [0], ethers.constants.AddressZero),
                ).to.be.revertedWith(`AV_ZeroAddress("to")`);
            });

            it("should revert when user specifies zero address as the token address to withdraw", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);
                const tokenId = await depositERC721(mockERC721, vault, user);

                await vault.enableWithdraw();
                await expect(
                    vault.connect(user).withdrawBatch([ethers.constants.AddressZero], [tokenId], [0], user.address),
                ).to.be.revertedWith(`AV_ZeroAddress("token")`);
            });

            it("should revert when user specifies invalid tokenType", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);
                const tokenId = await depositERC721(mockERC721, vault, user);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawBatch([mockERC721.address], [tokenId], [2], user.address)).to
                    .be.reverted;
            });

            it("should fail to withdrawBatch when withdraws disabled", async () => {
                const { vault, mockERC721, user } = await loadFixture(fixture);
                const tokenId = await depositERC721(mockERC721, vault, user);

                await expect(
                    vault.connect(user).withdrawBatch([mockERC721.address], [tokenId], [0], user.address),
                ).to.be.revertedWith("AV_WithdrawsDisabled");
            });

            it("should throw when withdrawBatch called by non-owner", async () => {
                const { vault, mockERC721, user, other } = await loadFixture(fixture);
                const tokenId = await depositERC721(mockERC721, vault, user);

                await vault.enableWithdraw();
                await expect(
                    vault.connect(other).withdrawBatch([mockERC721.address], [tokenId], [0], other.address),
                ).to.be.revertedWith("OERC721_CallerNotOwner");
            });
        });

        describe("ETH", () => {
            const deposit = async (vault: AssetVault, user: Signer, amount: BigNumber) => {
                await user.sendTransaction({
                    to: vault.address,
                    value: amount,
                });
            };

            it("should withdraw single deposit from a bundle", async () => {
                const { vault, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseEther("123");
                await deposit(vault, user, amount);
                const startingBalance = await vault.provider.getBalance(user.address);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawETH(user.address))
                    .to.emit(vault, "WithdrawETH")
                    .withArgs(user.address, user.address, amount);

                const threshold = hre.ethers.utils.parseEther("0.01"); // for txn fee
                const endingBalance = await vault.provider.getBalance(user.address);
                expect(endingBalance.sub(startingBalance).gt(amount.sub(threshold))).to.be.true;
            });

            it("should fail to withdraw when withdraws disabled", async () => {
                const { vault, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseEther("123");
                await deposit(vault, user, amount);

                await expect(vault.connect(user).withdrawETH(user.address)).to.be.revertedWith("AV_WithdrawsDisabled");
            });

            it("should throw when withdraw called by non-owner", async () => {
                const { vault, user, other } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseEther("9");
                await deposit(vault, user, amount);

                await expect(vault.connect(other).withdrawETH(other.address)).to.be.revertedWith(
                    "OERC721_CallerNotOwner",
                );
            });

            it("should fail when recipient is address zero", async () => {
                const { vault, user } = await loadFixture(fixture);
                const amount = hre.ethers.utils.parseEther("123");
                await deposit(vault, user, amount);
                const startingBalance = await vault.provider.getBalance(user.address);

                await vault.enableWithdraw();
                await expect(vault.connect(user).withdrawETH(ethers.constants.AddressZero)).to.be.revertedWith(
                    `AV_ZeroAddress("to")`,
                );
            });
        });

        describe("Introspection", function () {
            it("should return true for declaring support for eip165 interface contract", async () => {
                const { nft } = await loadFixture(fixture);
                // https://eips.ethereum.org/EIPS/eip-165#test-cases
                expect(await nft.supportsInterface("0x01ffc9a7")).to.be.true;
                expect(await nft.supportsInterface("0xfafafafa")).to.be.false;
            });
        });
    });
});
