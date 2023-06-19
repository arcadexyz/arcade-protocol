import { expect } from "chai";
import hre, { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber, BigNumberish } from "ethers";
import { fromRpcSig } from "ethereumjs-util";

import { ZERO_ADDRESS } from "./utils/erc20";
import { CallWhitelist, AssetVault, VaultFactory, FeeController, BaseURIDescriptor } from "../typechain";
import { deploy } from "./utils/contracts";
import { ADMIN_ROLE, FEE_CLAIMER_ROLE, BASE_URI, RESOURCE_MANAGER_ROLE } from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    factory: VaultFactory;
    vaultTemplate: AssetVault;
    whitelist: CallWhitelist;
    descriptor: BaseURIDescriptor;
    feeController: FeeController;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

describe("VaultFactory", () => {
    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await hre.ethers.getSigners();
        const whitelist = <CallWhitelist>await deploy("CallWhitelist", signers[0], []);
        const vaultTemplate = <AssetVault>await deploy("AssetVault", signers[0], []);
        const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI])
        const feeController = <FeeController>await deploy("FeeController", signers[0], []);

        const factory = <VaultFactory>(
            await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address])
        );

        return {
            factory,
            whitelist,
            feeController,
            vaultTemplate,
            descriptor,
            user: signers[0],
            other: signers[1],
            signers: signers.slice(2)
        };
    };

    const createVault = async (factory: VaultFactory, to: Signer): Promise<AssetVault> => {
        const tx = await factory.initializeBundle(to.address);
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

    it("should fail to initialize if passed an invalid template", async () => {
        const { whitelist, feeController, descriptor } = await loadFixture(fixture);

        const VaultFactory = await hre.ethers.getContractFactory("VaultFactory");
        await expect(
            VaultFactory.deploy(ZERO_ADDRESS, whitelist.address, feeController.address, descriptor.address),
        ).to.be.revertedWith(`VF_ZeroAddress("template")`);
    });

    it("should return template address", async () => {
        const { factory, vaultTemplate } = await loadFixture(fixture);
        expect(await factory.template()).to.equal(vaultTemplate.address);
    });

    it("should fail to initialize if passed an invalid whitelist", async () => {
        const { vaultTemplate, feeController, descriptor } = await loadFixture(fixture);

        const VaultFactory = await hre.ethers.getContractFactory("VaultFactory");
        await expect(
            VaultFactory.deploy(vaultTemplate.address, ZERO_ADDRESS, feeController.address, descriptor.address),
        ).to.be.revertedWith(`VF_ZeroAddress("whitelist")`);
    });

    it("should fail to initialize if passed an invalid descriptor", async () => {
        const { vaultTemplate, whitelist, feeController } = await loadFixture(fixture);

        const VaultFactory = await hre.ethers.getContractFactory("VaultFactory");
        await expect(
            VaultFactory.deploy(vaultTemplate.address, whitelist.address, feeController.address, ZERO_ADDRESS),
        ).to.be.revertedWith(`VF_ZeroAddress("descriptor")`);
    });

    it("should return whitelist address", async () => {
        const { factory, whitelist } = await loadFixture(fixture);
        expect(await factory.whitelist()).to.equal(whitelist.address);
    });

    it("should fail to initialize if passed an invalid fee controller", async () => {
        const { vaultTemplate, whitelist, descriptor } = await loadFixture(fixture);

        const VaultFactory = await hre.ethers.getContractFactory("VaultFactory");
        await expect(
            VaultFactory.deploy(vaultTemplate.address, whitelist.address, ZERO_ADDRESS, descriptor.address),
        ).to.be.revertedWith(`VF_ZeroAddress("feeController")`);
    });

    it("should return fee controller address", async () => {
        const { factory, feeController } = await loadFixture(fixture);
        expect(await factory.feeController()).to.equal(feeController.address);
    });

    describe("isInstance", async () => {
        it("Should return false for non-instance address", async () => {
            const { factory, user } = await loadFixture(fixture);

            expect(await factory.isInstance(user.address)).to.be.false;
        });

        it("Should return true for instance address", async () => {
            const { factory, user } = await loadFixture(fixture);

            const vault = await createVault(factory, user);
            expect(await factory.isInstance(vault.address)).to.be.true;
        });
    });

    describe("instanceCount", async () => {
        it("Should return 0 at first", async () => {
            const { factory } = await loadFixture(fixture);

            expect(await factory.instanceCount()).to.equal(0);
        });

        it("Should increment with bundles", async () => {
            const { factory, user } = await loadFixture(fixture);

            expect(await factory.instanceCount()).to.equal(0);

            await factory.initializeBundle(user.address);
            expect(await factory.instanceCount()).to.equal(1);

            await factory.initializeBundle(user.address);
            expect(await factory.instanceCount()).to.equal(2);

            await factory.initializeBundle(user.address);
            expect(await factory.instanceCount()).to.equal(3);
        });
    });

    describe("instanceAt", async () => {
        it("Should revert if no vault at index", async () => {
            const { factory, user } = await loadFixture(fixture);
            // no vault created...
            await expect(factory.instanceAt(0)).to.be.revertedWith("VF_TokenIdOutOfBounds");
        });

        it("Should return vaults at index", async () => {
            const { factory, user } = await loadFixture(fixture);
            // create vaults
            const vault1 = await createVault(factory, user);
            const vault2 = await createVault(factory, user);
            const vault3 = await createVault(factory, user);
            //find the address of vault at specified index
            const instAtIndex1 = await factory.instanceAtIndex(0);
            const instAtIndex2 = await factory.instanceAtIndex(1);
            const instAtIndex3 = await factory.instanceAtIndex(2);
            //use index returned to get the address of vault and compare
            expect(await factory.instanceAt(instAtIndex1)).to.equal(vault1.address);
            expect(await factory.instanceAt(instAtIndex2)).to.equal(vault2.address);
            expect(await factory.instanceAt(instAtIndex3)).to.equal(vault3.address);
        });
    });

    describe("mint fees", async () => {
        let ctx: TestContext;
        const MINT_FEE = ethers.utils.parseEther("0.1");

        beforeEach(async () => {
            ctx = await loadFixture(fixture);

            // Set a mint fee of 0.1 ETH
            await ctx.feeController.set(await ctx.feeController.FL_01(), MINT_FEE);
        });

        it("should fail to mint if the required fee is not provided", async () => {
            const { user, factory } = ctx;

            await expect(
                factory.initializeBundle(user.address)
            ).to.be.revertedWith("VF_InsufficientMintFee");
        });

        it("mints and reserves a fee for later collection", async () => {
            const { user, factory } = ctx;

            const userBalanceBefore = await ethers.provider.getBalance(user.address);

            await expect(
                factory.initializeBundle(user.address, { value: MINT_FEE })
            ).to.emit(factory, "VaultCreated");

            const userBalanceAfter = await ethers.provider.getBalance(user.address);

            expect(userBalanceBefore.sub(userBalanceAfter)).to.be.gt(MINT_FEE);
            expect(await ethers.provider.getBalance(factory.address)).to.eq(MINT_FEE);
        });

        it("refunds an overpaid mint fee", async () => {
            const { user, factory } = ctx;

            const userBalanceBefore = await ethers.provider.getBalance(user.address);

            await expect(
                factory.initializeBundle(user.address, { value: MINT_FEE.mul(10) }) // extra large fee paid
            ).to.emit(factory, "VaultCreated");

            const userBalanceAfter = await ethers.provider.getBalance(user.address);

            expect(userBalanceBefore.sub(userBalanceAfter)).to.be.gt(MINT_FEE);
            expect(await ethers.provider.getBalance(factory.address)).to.eq(MINT_FEE);
        });

        it("mint fee cannot be collected by non-admin", async () => {
            const { user, other, factory } = ctx;

            await expect(
                factory.initializeBundle(user.address, { value: MINT_FEE })
            ).to.emit(factory, "VaultCreated");

            await expect(factory.connect(other).claimFees(other.address)).to.be.revertedWith(
                `AccessControl: account ${other.address.toLowerCase()} is missing role ${FEE_CLAIMER_ROLE}`,
            );
        });

        it("collects the mint fee", async () => {
            const { user, factory } = ctx;

            await expect(
                factory.initializeBundle(user.address, { value: MINT_FEE })
            ).to.emit(factory, "VaultCreated");

            expect(await ethers.provider.getBalance(factory.address)).to.eq(MINT_FEE);

            await expect(factory.connect(user).claimFees(user.address))
                .to.emit(factory, "ClaimFees")
                .withArgs(user.address, MINT_FEE);
        });

        it("reverts if claimFees() is called to address zero", async () => {
            const { user, factory } = ctx;

            await expect(factory.initializeBundle(user.address, { value: MINT_FEE })).to.emit(factory, "VaultCreated");

            expect(await ethers.provider.getBalance(factory.address)).to.eq(MINT_FEE);

            await expect(factory.connect(user).claimFees(ethers.constants.AddressZero)).to.be.revertedWith(
                `VF_ZeroAddress("to")`
            );
        });
    })

    describe("Permit", () => {
        const typedData = {
            types: {
                Permit: [
                    { name: "owner", type: "address" },
                    { name: "spender", type: "address" },
                    { name: "tokenId", type: "uint256" },
                    { name: "nonce", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                ],
            },
            primaryType: "Permit" as const,
        };

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const chainId = hre.network.config.chainId!;
        const maxDeadline = hre.ethers.constants.MaxUint256;

        const buildData = (
            chainId: number,
            verifyingContract: string,
            name: string,
            version: string,
            owner: string,
            spender: string,
            tokenId: BigNumberish,
            nonce: number,
            deadline = maxDeadline,
        ) => {
            return Object.assign({}, typedData, {
                domain: {
                    name,
                    version,
                    chainId,
                    verifyingContract,
                },
                message: { owner, spender, tokenId, nonce, deadline },
            });
        };

        it("should accept owner signature", async () => {
            const { factory, user, other } = await loadFixture(fixture);
            const vault = await createVault(factory, user);
            const bundleId = vault.address;
            const data = buildData(
                chainId,
                factory.address,
                await factory.name(),
                "1",
                user.address,
                other.address,
                vault.address,
                0,
            );

            const signature = await user._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            let approved = await factory.getApproved(bundleId);
            expect(approved).to.equal(hre.ethers.constants.AddressZero);

            await expect(
                factory.permit(user.address, other.address, bundleId, maxDeadline, v, r, s),
            )
                .to.emit(factory, "Approval")
                .withArgs(user.address, other.address, bundleId);

            approved = await factory.getApproved(bundleId);
            expect(approved).to.equal(other.address);

            //check nonce was incremented to one
            expect(await factory.nonces(user.address)).to.equal(1);
            //test coverage checking domain separator
            expect(await factory.DOMAIN_SEPARATOR());
        });

        it("rejects if given owner is not real owner", async () => {
            const { factory, user, other } = await loadFixture(fixture);
            const vault = await createVault(factory, user);
            const bundleId = vault.address;
            const data = buildData(
                chainId,
                factory.address,
                await factory.name(),
                "1",
                user.address,
                other.address,
                bundleId,
                0,
            );

            const signature = await user._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            const approved = await factory.getApproved(bundleId);
            expect(approved).to.equal(hre.ethers.constants.AddressZero);

            await expect(
                factory.permit(other.address, other.address, bundleId, maxDeadline, v, r, s),
            ).to.be.revertedWith("ERC721P_NotTokenOwner");
        });

        it("rejects if bundleId is not valid", async () => {
            const { factory, user, other } = await loadFixture(fixture);
            await createVault(factory, user);
            const bundleId = "12345";

            const data = buildData(
                chainId,
                factory.address,
                await factory.name(),
                "1",
                user.address,
                other.address,
                bundleId,
                0,
            );

            const signature = await user._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            await expect(
                factory.permit(other.address, other.address, bundleId, maxDeadline, v, r, s),
            ).to.be.revertedWith("ERC721: owner query for nonexistent token");
        });

        it("rejects reused signature", async () => {
            const { factory, user, other } = await loadFixture(fixture);
            const vault = await createVault(factory, user);
            const bundleId = vault.address;
            const data = buildData(
                chainId,
                factory.address,
                await factory.name(),
                "1",
                user.address,
                other.address,
                bundleId,
                0,
            );

            const signature = await user._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            await expect(
                factory.permit(user.address, other.address, bundleId, maxDeadline, v, r, s),
            )
                .to.emit(factory, "Approval")
                .withArgs(user.address, other.address, bundleId);

            await expect(
                factory.permit(user.address, other.address, bundleId, maxDeadline, v, r, s),
            ).to.be.revertedWith("ERC721P_InvalidSignature");
        });

        it("rejects other signature", async () => {
            const { factory, user, other } = await loadFixture(fixture);
            const vault = await createVault(factory, user);
            const bundleId = vault.address;
            const data = buildData(
                chainId,
                factory.address,
                await factory.name(),
                "1",
                user.address,
                other.address,
                bundleId,
                0,
            );

            const signature = await other._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            await expect(
                factory.permit(user.address, other.address, bundleId, maxDeadline, v, r, s),
            ).to.be.revertedWith("ERC721P_InvalidSignature");
        });

        it("rejects expired signature", async () => {
            const { factory, user, other } = await loadFixture(fixture);
            const vault = await createVault(factory, user);
            const bundleId = vault.address;
            const data = buildData(
                chainId,
                factory.address,
                await factory.name(),
                "1",
                user.address,
                other.address,
                bundleId,
                0, // nonce
                BigNumber.from("1234"), // deadline
            );

            const signature = await user._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            const approved = await factory.getApproved(bundleId);
            expect(approved).to.equal(hre.ethers.constants.AddressZero);

            await expect(
                factory.permit(user.address, other.address, bundleId, "1234", v, r, s),
            ).to.be.revertedWith("ERC721P_DeadlineExpired");
        });
    });

    describe("ERC721", () => {
        let token: VaultFactory;
        let user: Signer, other: Signer, signers: Signer[];

        const initializeBundle = async (token: VaultFactory, user: Signer): Promise<BigNumberish> => {
            const vault = await createVault(token, user);
            return vault.address;
        };

        context("with minted tokens", function () {
            beforeEach(async () => {
                const {
                    factory,
                    user: userSigner,
                    other: otherSigner,
                    signers: otherSigners,
                } = await loadFixture(fixture);
                user = userSigner;
                other = otherSigner;
                token = factory;
                signers = otherSigners;
            });

            describe("balanceOf", function () {
                context("when the given address owns some tokens", function () {
                    it("returns the amount of tokens owned by the given address", async function () {
                        await createVault(token, user);
                        await createVault(token, user);
                        expect(await token.balanceOf(user.address)).to.equal(BigNumber.from("2"));
                    });
                });

                context("when the given address does not own any tokens", function () {
                    it("returns 0", async function () {
                        expect(await token.balanceOf(other.address)).to.equal(BigNumber.from("0"));
                    });
                });

                context("when querying the zero address", function () {
                    it("throws", async function () {
                        await expect(token.balanceOf(ZERO_ADDRESS)).to.be.revertedWith(
                            "ERC721: balance query for the zero address",
                        );
                    });
                });
            });

            describe("ownerOf", function () {
                context("when the given token ID was tracked by this token", function () {
                    it("returns the owner of the given token ID", async function () {
                        const tokenId = await initializeBundle(token, user);
                        expect(await token.ownerOf(tokenId)).to.be.equal(user.address);
                    });
                });

                context("when the given token ID was not tracked by this token", function () {
                    it("reverts", async function () {
                        await expect(token.ownerOf("123412341234")).to.be.revertedWith(
                            "ERC721: owner query for nonexistent token",
                        );
                    });
                });
            });

            describe("transfers", function () {
                describe("transferFrom", function () {
                    const testTransfer = async (
                        token: VaultFactory,
                        from: Signer,
                        to: Signer,
                        caller: Signer,
                        tokenId: BigNumberish,
                    ) => {
                        const preSenderBalance = await token.balanceOf(from.address);
                        const preRecipientBalance = await token.balanceOf(to.address);
                        await expect(
                            token.connect(caller).transferFrom(from.address, to.address, tokenId),
                        )
                            .to.emit(token, "Transfer")
                            .withArgs(from.address, to.address, tokenId)
                            .to.emit(token, "Approval")
                            .withArgs(from.address, ZERO_ADDRESS, tokenId);

                        expect(await token.ownerOf(tokenId)).to.equal(to.address);
                        expect(await token.getApproved(tokenId)).to.equal(ZERO_ADDRESS);
                        const postSenderBalance = await token.balanceOf(from.address);
                        const postRecipientBalance = await token.balanceOf(to.address);
                        expect(postSenderBalance).to.equal(preSenderBalance.sub(1));
                        expect(postRecipientBalance).to.equal(preRecipientBalance.add(1));

                        if (postSenderBalance.gt(0)) {
                            expect(await token.tokenOfOwnerByIndex(from.address, 0)).to.not.equal(tokenId);
                        } else {
                            await expect(token.tokenOfOwnerByIndex(from.address, 0)).to.be.revertedWith(
                                "ERC721Enumerable: owner index out of bounds",
                            );
                        }

                        if (postRecipientBalance.gt(0)) {
                            expect(await token.tokenOfOwnerByIndex(to.address, 0)).to.equal(tokenId);
                        } else {
                            await expect(token.tokenOfOwnerByIndex(to.address, 0)).to.be.revertedWith(
                                "ERC721Enumerable: owner index out of bounds",
                            );
                        }
                    };

                    it("succeeds when called by owner", async () => {
                        const tokenId = await initializeBundle(token, user);
                        await testTransfer(token, user, other, user, tokenId);
                    });

                    it("succeeds when called by approved user", async () => {
                        const approved = signers[0];
                        const tokenId = await initializeBundle(token, user);
                        await token.connect(user).approve(approved.address, tokenId);
                        await testTransfer(token, user, other, approved, tokenId);
                    });

                    it("succeeds when called by an operator", async () => {
                        const operator = signers[1];
                        const tokenId = await initializeBundle(token, user);
                        await token.connect(user).setApprovalForAll(operator.address, true);
                        await testTransfer(token, user, other, operator, tokenId);
                    });

                    describe("properly performs a self-send", async () => {
                        let tokenId: BigNumberish;

                        beforeEach(async () => {
                            tokenId = await initializeBundle(token, user);
                            await expect(
                                token
                                    .connect(user)
                                    .transferFrom(user.address, user.address, tokenId),
                            )
                                .to.emit(token, "Transfer")
                                .withArgs(user.address, user.address, tokenId)
                                .to.emit(token, "Approval")
                                .withArgs(user.address, ZERO_ADDRESS, tokenId);
                        });

                        it("keeps ownership of the token", async function () {
                            expect(await token.ownerOf(tokenId)).to.equal(user.address);
                        });

                        it("clears the approval for the token ID", async function () {
                            expect(await token.getApproved(tokenId)).to.equal(ZERO_ADDRESS);
                        });

                        it("keeps the owner balance", async function () {
                            expect(await token.balanceOf(user.address)).to.equal(BigNumber.from("1"));
                        });
                    });

                    it("fails when the owner address is incorrect", async () => {
                        const tokenId = await initializeBundle(token, user);
                        await expect(
                            token
                                .connect(user)
                                .transferFrom(other.address, other.address, tokenId),
                        ).to.be.revertedWith("ERC721: transfer of token that is not own");
                    });

                    it("fails when the sender is not authorized", async () => {
                        const tokenId = await initializeBundle(token, user);
                        await expect(
                            token
                                .connect(other)
                                .transferFrom(user.address, other.address, tokenId),
                        ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
                    });

                    it("fails when the token id does not exist", async () => {
                        const nonexistentTokenId = 123412341243;
                        await expect(
                            token
                                .connect(user)
                                .transferFrom(user.address, other.address, nonexistentTokenId),
                        ).to.be.revertedWith("ERC721: operator query for nonexistent token");
                    });

                    it("fails when the recipient is the zero address", async () => {
                        const tokenId = await initializeBundle(token, user);
                        await expect(
                            token.connect(user).transferFrom(user.address, ZERO_ADDRESS, tokenId),
                        ).to.be.revertedWith("zero");
                    });
                });
            });
        });

        describe("Resource management", () => {
            let ctx: TestContext;
            let newDescriptor: BaseURIDescriptor;
            // const otherBaseURI = "https://example.com/";
            const otherBaseURI = BASE_URI;

            beforeEach(async () => {
                ctx = await loadFixture(fixture);
                const [deployer] = await ethers.getSigners()

                newDescriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", deployer, [otherBaseURI]);
                await newDescriptor.deployed();

                expect(await newDescriptor.baseURI()).to.be.eq(otherBaseURI);
            })

            it("gets the tokenURI", async () => {
                const { factory, user } = ctx;

                await createVault(factory, user);
                const tokenId = await factory.tokenOfOwnerByIndex(user.address, 0);

                expect(await factory.tokenURI(tokenId.toString())).to.be.eq(`${BASE_URI}${tokenId}`);
            });

            it("reverts if non-admin tries to change the descriptor", async () => {
                const { factory, other } = ctx;

                await expect(factory.connect(other).setDescriptor(newDescriptor.address))
                    .to.be.revertedWith("AccessControl");
            });

            it("reverts if descriptor is set to 0 address", async () => {
                const { factory, other } = ctx;
                await factory.grantRole(RESOURCE_MANAGER_ROLE, other.address);

                await expect(factory.connect(other).setDescriptor(ZERO_ADDRESS)).to.be.revertedWith(
                    `VF_ZeroAddress("descriptor")`
                );
            });

            it("changes the descriptor", async () => {
                const { factory, other, user } = ctx;
                await factory.grantRole(RESOURCE_MANAGER_ROLE, other.address);

                expect(await newDescriptor.baseURI()).to.be.eq(otherBaseURI);

                await expect(factory.connect(other).setDescriptor(newDescriptor.address))
                    .to.emit(factory, "SetDescriptor")
                    .withArgs(other.address, newDescriptor.address);

                expect(await newDescriptor.baseURI()).to.be.eq(otherBaseURI);

                await createVault(factory, user);
                const tokenId = await factory.tokenOfOwnerByIndex(user.address, 0);
                expect(await factory.tokenURI(tokenId.toString())).to.be.eq(`${otherBaseURI}${tokenId}`);
            });
        });

        it("gets the tokenURI", async () => {
            const { factory, user } = await loadFixture(fixture);

            await createVault(factory, user);
            const tokenId = await factory.tokenOfOwnerByIndex(user.address, 0);

            expect(await factory.tokenURI(tokenId.toString())).to.be.eq(`${BASE_URI}${tokenId}`);
        });

        it("reverts if the tokenURI does not exist", async () => {
            const { factory } = await loadFixture(fixture);
            const tokenId = 1;

            await expect(factory.tokenURI(tokenId.toString())).to.be.revertedWith(`VF_DoesNotExist(${tokenId})`);
        });
    });
});
