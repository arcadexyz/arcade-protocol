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
    FeeController
} from "../typechain";
import { deploy } from "./utils/contracts";
import { initializeBundle } from "./utils/loans";


type Signer = SignerWithAddress;

interface TestContext {
    verifier: CollectionWideOfferVerifier;
    mockERC721: MockERC721;
    deployer: SignerWithAddress;
    vaultFactory: VaultFactory;
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
        const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address])


        return { verifier, mockERC721, deployer, vaultFactory };
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
                    101,
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address])
                )
            ).to.eq(true);
        });

        it("reverts if the collateral address does not match the predicate and is not a vault", async () => {
            const { verifier, mockERC721, deployer } = ctx;
            const otherMockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK2"]);

            await expect(
                verifier.verifyPredicates(
                    otherMockERC721.address,
                    101,
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address])
                )
            ).to.be.revertedWith("function selector was not recognized and there's no fallback function");
        });

        it("returns false if the vault does not hold the token", async () => {
            const { verifier, mockERC721, vaultFactory, deployer } = ctx;

            const bundleId = await initializeBundle(vaultFactory, deployer);

            expect(
                await verifier.verifyPredicates(
                    vaultFactory.address,
                    bundleId,
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address])
                )
            ).to.eq(false);
        });

        it("verifies a token held by a vault", async () => {
            const { verifier, mockERC721, vaultFactory, deployer } = ctx;

            const bundleId = await initializeBundle(vaultFactory, deployer);
            await mockERC721.mint(await vaultFactory.instanceAt(bundleId));

            expect(
                await verifier.verifyPredicates(
                    vaultFactory.address,
                    bundleId,
                    ethers.utils.defaultAbiCoder.encode(["address"], [mockERC721.address])
                )
            ).to.eq(true);
        });
    });
});
