import { expect } from "chai";
import hre, { ethers, waffle } from "hardhat";

const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
    AssetVault,
    CallWhitelist,
    VaultFactory,
    GenArt721Core,
    ArtBlocksVerifier,
    FeeController,
    BaseURIDescriptor,
    CollisionVaultFactory
} from "../typechain";
import { deploy } from "./utils/contracts";

import { encodeArtBlocksItems, initializeBundle } from "./utils/loans";
import { ABSignatureItem } from "./utils/types";
import { BASE_URI } from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    verifier: ArtBlocksVerifier;
    artblocks: GenArt721Core;
    vaultFactory: VaultFactory;
    collisionFactory: CollisionVaultFactory;
    deployer: Signer;
    user: Signer;
    minter: Signer;
    signers: Signer[];
}

describe("ArtBlocksVerifier", () => {
    const price = ethers.utils.parseEther("0.1");

    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await hre.ethers.getSigners();
        const [deployer, user, minter] = signers;

        const whitelist = <CallWhitelist>await deploy("CallWhitelist", deployer, []);
        const artblocks = <GenArt721Core>await deploy("GenArt721Core", signers[0], ["ArtBlocks Test", "AB"]);
        const verifier = <ArtBlocksVerifier>await deploy("ArtBlocksVerifier", deployer, []);

        const vaultTemplate = <AssetVault>await deploy("AssetVault", deployer, []);
        const feeController = <FeeController>await deploy("FeeController", signers[0], []);
        const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI])
        const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address])
        const collisionFactory = <CollisionVaultFactory>await deploy("CollisionVaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address])

        // Mint a few projects - will start with ID 3
        await artblocks.addProject("Project 1", user.address, price, false);
        await artblocks.addProject("Project 2", user.address, price, false);
        await artblocks.addProject("Project 3", user.address, price, false);

        await artblocks.connect(user).toggleProjectIsPaused(3);
        await artblocks.connect(user).toggleProjectIsPaused(4);
        await artblocks.connect(user).toggleProjectIsPaused(5);
        await artblocks.connect(deployer).toggleProjectIsActive(3);
        await artblocks.connect(deployer).toggleProjectIsActive(4);
        await artblocks.connect(deployer).toggleProjectIsActive(5);

        await artblocks.connect(deployer).addMintWhitelisted(minter.address);

        return {
            verifier,
            artblocks,
            vaultFactory,
            deployer,
            user,
            minter,
            signers: signers.slice(2),
            collisionFactory
        };
    };

    describe("verifyPredicates", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("fails when the list of predicates is empty", async () => {
            const { vaultFactory, user, artblocks, verifier, deployer, minter } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tx = await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);;
            const receipt = await tx.wait();
            const tokenId = receipt.events?.[0].args?.tokenId;

            // No encoded predicates
            const signatureItems: ABSignatureItem[] = [];

            await expect(verifier.verifyPredicates(deployer.address, minter.address, vaultFactory.address, bundleId, encodeArtBlocksItems(signatureItems)))
                .to.be.revertedWith("IV_NoPredicates");
        });

        it("fails for an item with zero address", async () => {
            const { vaultFactory, user, artblocks, verifier, deployer, minter } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tx = await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);
            const receipt = await tx.wait();
            const tokenId = receipt.events?.[0].args?.tokenId;

            // Create predicate for a single ID
            const signatureItems: ABSignatureItem[] = [
                {
                    asset: "0x0000000000000000000000000000000000000000",
                    projectId: 3,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false,
                },
            ];

            await expect(
                verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId,
                    encodeArtBlocksItems(signatureItems),
                ),
            ).to.be.revertedWith("IV_ItemMissingAddress");
        });

        it("fails if the project ID is out of bounds", async () => {
            const { vaultFactory, user, artblocks, verifier, deployer, minter } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tx = await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);
            const receipt = await tx.wait();
            const tokenId = receipt.events?.[0].args?.tokenId;

            // Create predicate for a single ID
            const signatureItems: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 10, // No project with this ID
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false,
                },
            ];

            await expect(
                verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId,
                    encodeArtBlocksItems(signatureItems),
                ),
            ).to.be.revertedWith("IV_InvalidProjectId");
        });

        it("fails if the vault address does not convert into the collateralId", async () => {
            const { user, artblocks, verifier, deployer, minter, collisionFactory } = ctx;

            const bundleId = await initializeBundle(collisionFactory, user);
            const bundleAddress = await collisionFactory.instanceAt(bundleId);
            const tx = await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);;
            const receipt = await tx.wait();
            const tokenId = receipt.events?.[0].args?.tokenId.sub(1_000_000 * 3);

            const signatureItems: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 3,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            // Create tokenId that will collide with existing vault
            const collidingId = await collisionFactory.callStatic.initializeCollision(bundleAddress, user.address);
            await collisionFactory.initializeCollision(bundleAddress, user.address);

            await expect(
                verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    collisionFactory.address,
                    collidingId,
                    encodeArtBlocksItems(signatureItems)
                )
            ).to.be.revertedWith("IV_InvalidCollateralId");
        });

        it("fails if the amount is not specified", async () => {
            const { vaultFactory, user, artblocks, verifier, deployer, minter } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);;

            // Use anyIdAllowed, but mark amount as 0
            const signatureItems: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 3,
                    tokenId: 0,
                    amount: 0,
                    anyIdAllowed: true
                },
            ];

            await expect(verifier.verifyPredicates(deployer.address, minter.address, vaultFactory.address, bundleId, encodeArtBlocksItems(signatureItems)))
                .to.be.revertedWith("IV_NoAmount");
        });

        it("returns true for an owned specific project/token pair", async () => {
            const { vaultFactory, user, artblocks, verifier, deployer, minter } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tx = await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);
            const receipt = await tx.wait();
            const tokenId = receipt.events?.[0].args?.tokenId.sub(1_000_000 * 3);

            // Amount marked as 0 - will be ignored
            const signatureItems: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 3,
                    tokenId,
                    amount: 0,
                    anyIdAllowed: false
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId,
                    encodeArtBlocksItems(signatureItems),
                ),
            ).to.be.true;
        });

        it("returns true for a project wildcard", async () => {
            const { vaultFactory, user, artblocks, verifier, deployer, minter } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);

            await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);

            const signatureItems: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 3,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId,
                    encodeArtBlocksItems(signatureItems),
                ),
            ).to.be.true;
            expect(
                await verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId2,
                    encodeArtBlocksItems(signatureItems),
                ),
            ).to.be.false;
        });

        it("returns false for a specific token id which is not owned", async () => {
            const { vaultFactory, user, artblocks, verifier, deployer, minter } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);
            await artblocks.connect(minter).mint(user.address, 3, deployer.address);

            const signatureItems: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 3,
                    tokenId: 1, // Different token ID than minted
                    amount: 1,
                    anyIdAllowed: false,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId,
                    encodeArtBlocksItems(signatureItems),
                ),
            ).to.be.false;
        });

        it("returns false for an project wildcard which is not owned", async () => {
            const { vaultFactory, user, artblocks, verifier, deployer, minter } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);

            await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);

            const signatureItems: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 3,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true,
                },
            ];

            const signatureItemsFalse: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 4,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId,
                    encodeArtBlocksItems(signatureItems),
                ),
            ).to.be.true;
            expect(
                await verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId,
                    encodeArtBlocksItems(signatureItemsFalse),
                ),
            ).to.be.false;
        });

        it("returns true for a combination of multiple predicates", async () => {
            const { vaultFactory, user, artblocks, verifier, deployer, minter } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);

            await artblocks.connect(minter).mint(bundleAddress, 3, deployer.address);

            const tx = await artblocks.connect(minter).mint(bundleAddress, 4, deployer.address);
            const receipt = await tx.wait();
            const tokenId = receipt.events?.[0].args?.tokenId.sub(1_000_000 * 4);

            await artblocks.connect(minter).mint(bundleAddress, 5, deployer.address);
            await artblocks.connect(minter).mint(bundleAddress, 5, deployer.address);

            // Check 1 wildcard, check 1 specific ID, and check 1 wildcard of amount > 1
            const signatureItems: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 3,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true,
                },
                {
                    asset: artblocks.address,
                    projectId: 4,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false,
                },
                {
                    asset: artblocks.address,
                    projectId: 5,
                    tokenId: 0,
                    amount: 2,
                    anyIdAllowed: true,
                },
            ];

            // Check a larger amount, when 2 are owned
            const signatureItemsFalse: ABSignatureItem[] = [
                {
                    asset: artblocks.address,
                    projectId: 5,
                    tokenId: 0,
                    amount: 5,
                    anyIdAllowed: true,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId,
                    encodeArtBlocksItems(signatureItems),
                ),
            ).to.be.true;
            expect(
                await verifier.verifyPredicates(
                    deployer.address,
                    minter.address,
                    vaultFactory.address,
                    bundleId,
                    encodeArtBlocksItems(signatureItemsFalse),
                ),
            ).to.be.false;
        });
    });
});
