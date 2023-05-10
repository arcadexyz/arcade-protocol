import { expect } from "chai";
import hre, { waffle, ethers } from "hardhat";
import { BigNumberish } from "ethers";

const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
    UnvaultedItemsVerifier,
    MockERC721
} from "../typechain";
import { deploy } from "./utils/contracts";
import { encodeItemCheck } from "./utils/loans";

import { ZERO_ADDRESS } from "./utils/erc20";

type Signer = SignerWithAddress;

interface TestContext {
    verifier: UnvaultedItemsVerifier;
    mockERC721: MockERC721;
    deployer: SignerWithAddress;
}

describe("UnvaultedItemsVerifier", () => {
    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await ethers.getSigners();
        const [deployer] = signers;

        const mockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);
        const verifier = <UnvaultedItemsVerifier>await deploy("UnvaultedItemsVerifier", deployer, []);

        return { verifier, mockERC721, deployer };
    };

    describe("verifyPredicates", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("fails for an invalid token address", async () => {
            const { verifier, mockERC721 } = ctx;

            await expect(
                verifier.verifyPredicates(
                    mockERC721.address,
                    100,
                    encodeItemCheck(ZERO_ADDRESS, 100, false)
                )
            ).to.be.revertedWith("IV_ItemMissingAddress");
        });

        it("verifies a specific token id", async () => {
            const { verifier, mockERC721 } = ctx;

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    100,
                    encodeItemCheck(mockERC721.address, 99, false)
                )
            ).to.eq(false);

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    99,
                    encodeItemCheck(mockERC721.address, 100, false)
                )
            ).to.eq(false);

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    100,
                    encodeItemCheck(mockERC721.address, 100, false)
                )
            ).to.eq(true);
        });

        it("verifies any token id", async () => {
            const { verifier, mockERC721, deployer } = ctx;

            const otherMockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK2"]);

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    100,
                    encodeItemCheck(mockERC721.address, 100, true)
                )
            ).to.eq(true);

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    100,
                    encodeItemCheck(mockERC721.address, 0, true)
                )
            ).to.eq(true);

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    777,
                    encodeItemCheck(mockERC721.address, 0, true)
                )
            ).to.eq(true);

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    100,
                    encodeItemCheck(otherMockERC721.address, 0, true)
                )
            ).to.eq(false);

            expect(
                await verifier.verifyPredicates(
                    otherMockERC721.address,
                    100,
                    encodeItemCheck(mockERC721.address, 0, true)
                )
            ).to.eq(false);
        });
    });
});
