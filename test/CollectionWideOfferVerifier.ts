import { expect } from "chai";
import hre, { waffle, ethers } from "hardhat";

const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
    CollectionWideOfferVerifier,
    MockERC721,
    VaultFactory,
    CallWhitelist,
    AssetVault,
    FeeController,
    BaseURIDescriptor,
    CollisionVaultFactory
} from "../typechain";
import { deploy } from "./utils/contracts";
import { initializeBundle } from "./utils/loans";
import { BASE_URI } from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    verifier: CollectionWideOfferVerifier;
    mockERC721: MockERC721;
    deployer: SignerWithAddress;
    vaultFactory: VaultFactory;
    collisionFactory: CollisionVaultFactory;
}

describe("CollectionWideOfferVerifier", () => {
    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await ethers.getSigners();
        const [deployer] = signers;

        const mockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);
        const verifier = <CollectionWideOfferVerifier>await deploy("CollectionWideOfferVerifier", deployer, []);

        const whitelist = <CallWhitelist>await deploy("CallWhitelist", deployer, []);
        const vaultTemplate = <AssetVault>await deploy("AssetVault", deployer, []);
        const feeController = <FeeController>await deploy("FeeController", signers[0], []);
        const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI])
        const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address])
        const collisionFactory = <CollisionVaultFactory>await deploy("CollisionVaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address])

        return { verifier, mockERC721, deployer, vaultFactory, collisionFactory };
    };

    describe("verifyPredicates", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("verifies a token directly escrowed", async () => {
            const { verifier, mockERC721 } = ctx;

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    mockERC721.address,
                    101,
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address]),
                ),
            ).to.eq(true);
        });

        it("reverts if the collateral address does not match the predicate and is not a vault", async () => {
            const { verifier, mockERC721, deployer } = ctx;
            const otherMockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK2"]);

            await expect(
                verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    otherMockERC721.address,
                    101,
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address]),
                ),
            ).to.be.revertedWith("function selector was not recognized and there's no fallback function");
        });

        it("reverts if the collateral address is the vault factory but the ID does not represent a vault", async () => {
            const { verifier, vaultFactory, mockERC721, deployer } = ctx;
            const bundleId = await initializeBundle(vaultFactory, deployer);
            await mockERC721.mint(await vaultFactory.instanceAt(bundleId));

            await expect(
                verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    vaultFactory.address,
                    1010101010101, // diff bundle that has not been registered
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address])
                )
            ).to.be.revertedWith("VF_TokenIdOutOfBounds");
        });

        it("reverts if the vault address does not convert into the collateralId", async () => {
            const { verifier, mockERC721, deployer, collisionFactory } = ctx;

            const bundleId = await initializeBundle(collisionFactory, deployer);
            await mockERC721.mint(await collisionFactory.instanceAt(bundleId));

            // Create tokenId that will collide with existing vault
            const collidingId = await collisionFactory.callStatic.initializeCollision(bundleId.toString(), deployer.address);
            await collisionFactory.initializeCollision(bundleId.toString(), deployer.address);

            await expect(
                verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    collisionFactory.address,
                    collidingId,
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address])
                )
            ).to.be.revertedWith("IV_InvalidCollateralId");
        });

        it("returns false if the vault does not hold the token", async () => {
            const { verifier, mockERC721, vaultFactory, deployer } = ctx;

            const bundleId = await initializeBundle(vaultFactory, deployer);

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    vaultFactory.address,
                    bundleId,
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address]),
                ),
            ).to.eq(false);
        });

        it("verifies a token held by a vault", async () => {
            const { verifier, mockERC721, vaultFactory, deployer } = ctx;

            const bundleId = await initializeBundle(vaultFactory, deployer);
            await mockERC721.mint(await vaultFactory.instanceAt(bundleId));

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    vaultFactory.address,
                    bundleId,
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address]),
                ),
            ).to.eq(true);
        });
    });
});
