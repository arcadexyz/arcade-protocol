import { expect } from "chai";
import hre, { waffle, ethers } from "hardhat";
import { BigNumberish } from "ethers";

const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { UnvaultedItemsVerifier, MockERC721 } from "../typechain";
import { deploy } from "./utils/contracts";
import { encodeSignatureItems } from "./utils/loans";
import { SignatureItem } from "./utils/types";

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

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0, // ERC721
                    asset: ZERO_ADDRESS,
                    tokenId: 100,
                    amount: 1,
                    anyIdAllowed: false,
                },
            ];

            await expect(
                verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    mockERC721.address,
                    100,
                    encodeSignatureItems(signatureItems),
                ),
            ).to.be.revertedWith("IV_ItemMissingAddress");
        });

        it("verifies a specific token id", async () => {
            const { verifier, mockERC721 } = ctx;

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0, // ERC721
                    asset: mockERC721.address,
                    tokenId: 99,
                    amount: 1,
                    anyIdAllowed: false,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    mockERC721.address,
                    100,
                    encodeSignatureItems(signatureItems),
                ),
            ).to.eq(false);

            const signatureItems2: SignatureItem[] = [
                {
                    cType: 0, // ERC721
                    asset: mockERC721.address,
                    tokenId: 100,
                    amount: 1,
                    anyIdAllowed: false,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    mockERC721.address,
                    99,
                    encodeSignatureItems(signatureItems2),
                ),
            ).to.eq(false);

            const signatureItems3: SignatureItem[] = [
                {
                    cType: 0, // ERC721
                    asset: mockERC721.address,
                    tokenId: 100,
                    amount: 1,
                    anyIdAllowed: false,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    mockERC721.address,
                    100,
                    encodeSignatureItems(signatureItems3),
                ),
            ).to.eq(true);
        });

        it("verifies any token id", async () => {
            const { verifier, mockERC721, deployer } = ctx;

            const otherMockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK2"]);

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0, // ERC721
                    asset: mockERC721.address,
                    tokenId: 100,
                    amount: 1,
                    anyIdAllowed: true,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    mockERC721.address,
                    100,
                    encodeSignatureItems(signatureItems),
                ),
            ).to.eq(true);

            const signatureItems2: SignatureItem[] = [
                {
                    cType: 0, // ERC721
                    asset: mockERC721.address,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    mockERC721.address,
                    100,
                    encodeSignatureItems(signatureItems2),
                ),
            ).to.eq(true);

            const signatureItems3: SignatureItem[] = [
                {
                    cType: 0, // ERC721
                    asset: mockERC721.address,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    mockERC721.address,
                    777,
                    encodeSignatureItems(signatureItems3),
                ),
            ).to.eq(true);

            const signatureItems4: SignatureItem[] = [
                {
                    cType: 0, // ERC721
                    asset: otherMockERC721.address,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    mockERC721.address,
                    100,
                    encodeSignatureItems(signatureItems4),
                ),
            ).to.eq(false);

            const signatureItems5: SignatureItem[] = [
                {
                    cType: 0, // ERC721
                    asset: mockERC721.address,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true,
                },
            ];

            expect(
                await verifier.verifyPredicates(
                    mockERC721.address,
                    mockERC721.address,
                    otherMockERC721.address,
                    100,
                    encodeSignatureItems(signatureItems5),
                ),
            ).to.eq(false);
        });
    });
});
