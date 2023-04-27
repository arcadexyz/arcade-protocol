import { expect } from "chai";
import hre, { waffle, ethers } from "hardhat";
import { BigNumber } from "ethers";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
    ArcadeItemsVerifier,
    AssetVault,
    CallWhitelist,
    VaultFactory,
    MockERC20,
    MockERC721,
    MockERC1155,
} from "../typechain";
import { deploy } from "./utils/contracts";

import { SignatureItem } from "./utils/types";
import { mint as mint20 } from "./utils/erc20";
import { mint as mint721, mintToAddress as mint721ToAddress } from "./utils/erc721";
import { mint as mint1155 } from "./utils/erc1155";
import { encodeSignatureItems, initializeBundle } from "./utils/loans";

type Signer = SignerWithAddress;

interface TestContext {
    verifier: ArcadeItemsVerifier;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    mockERC1155: MockERC1155;
    vaultFactory: VaultFactory;
    deployer: Signer;
    user: Signer;
    signers: Signer[];
}

describe("ItemsVerifier", () => {
    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await hre.ethers.getSigners();
        const [deployer, user] = signers;

        const whitelist = <CallWhitelist>await deploy("CallWhitelist", deployer, []);
        const verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", deployer, []);
        const mockERC20 = <MockERC20>await deploy("MockERC20", deployer, ["Mock ERC20", "MOCK"]);
        const mockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);
        const mockERC1155 = <MockERC1155>await deploy("MockERC1155", deployer, []);

        const vaultTemplate = <AssetVault>await deploy("AssetVault", deployer, []);
        const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address])

        return {
            verifier,
            mockERC20,
            mockERC721,
            mockERC1155,
            vaultFactory,
            deployer,
            user,
            signers: signers.slice(2),
        };
    };

    describe("verifyPredicates", () => {
        let ctx: TestContext;

        before(async () => {
            ctx = await loadFixture(fixture);
        });

        it("fails for an invalid collateral type", async () => {
            const { vaultFactory, user, mockERC721, verifier } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress, tokenId);

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 4 as 0, // 4 is an invalid collateral type
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            // Will revert because 4 can't be parsed as an enum
            await expect(verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress)).to.be.reverted;
        });

        it("fails if a signature item is missing an address", async () => {
            const { vaultFactory, user, mockERC721, verifier } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress, tokenId);

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: "0x0000000000000000000000000000000000000000",
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            // Will revert because 4 can't be parsed as an enum
            await expect(
                verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress),
            ).to.be.revertedWith("IV_ItemMissingAddress");
        });

        it("fails if an ERC1155 item has a zero amount", async () => {
            const { vaultFactory, user, mockERC1155, verifier } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint1155(mockERC1155, user, BigNumber.from(10));

            await mockERC1155.connect(user).safeTransferFrom(user.address, bundleAddress, tokenId, 10, Buffer.from(""));

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 1,
                    asset: mockERC1155.address,
                    tokenId,
                    amount: 0, // invalid for 1155
                    anyIdAllowed: false
                },
            ];

            await expect(
                verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress),
            ).to.be.revertedWith("IV_NoAmount");
        });

        it("fails if a wildcard is attempted for an ERC1155", async () => {
            const { vaultFactory, user, mockERC1155, verifier } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint1155(mockERC1155, user, BigNumber.from(10));

            await mockERC1155.connect(user).safeTransferFrom(user.address, bundleAddress, tokenId, 10, Buffer.from(""));

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 1,
                    asset: mockERC1155.address,
                    tokenId,
                    amount: 5,
                    anyIdAllowed: true // invalid for 1155
                },
            ];

            // Will revert because 4 can't be parsed as an enum
            await expect(
                verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress),
            ).to.be.revertedWith("IV_InvalidWildcard");
        });

        it("fails if an ERC20 item has a non-positive required amount", async () => {
            const { vaultFactory, user, mockERC20, verifier } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);

            await mint20(mockERC20, user, 1000);
            await mockERC20.connect(user).transfer(bundleAddress, 1000);

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: mockERC20.address,
                    tokenId: 0,
                    amount: 0, // invalid for 20
                    anyIdAllowed: false
                },
            ];

            await expect(
                verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress),
            ).to.be.revertedWith("IV_NoAmount");
        });

        it("fails if a wildcard is attempted for an ERC20", async () => {
            const { vaultFactory, user, mockERC20, verifier } = ctx;

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);

            await mint20(mockERC20, user, 1000);
            await mockERC20.connect(user).transfer(bundleAddress, 1000);

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: mockERC20.address,
                    tokenId: 0,
                    amount: 1000,
                    anyIdAllowed: true // invalid for 20
                },
            ];

            await expect(
                verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress),
            ).to.be.revertedWith("IV_InvalidWildcard");
        });

        it("verifies a specific ERC721 and token id", async () => {
            const { vaultFactory, user, mockERC721, verifier } = ctx;

            // Start 2 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);

            // Fund both bundles with different token IDs
            const tokenId = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress, tokenId);

            const tokenId2 = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress2, tokenId2);

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            // First bundle should have item
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress)).to.be.true;
            // Second bundle should not
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress2)).to.be.false;
        });

        it("verifies a specific ERC721 with a large token ID (oob for int256)", async () => {
            const { vaultFactory, user, mockERC721, verifier } = ctx;

            // Start 2 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);

            // Fund both bundles with different token IDs
            // Make one token ID very large
            const tokenId = ethers.constants.MaxUint256.sub(10);
            await mockERC721.mintId(tokenId, user.address)
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress, tokenId);

            const tokenId2 = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress2, tokenId2);

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            // First bundle should have item
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress)).to.be.true;
            // Second bundle should not
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress2)).to.be.false;
        });

        it("verifies a specific ERC721 for any token id", async () => {
            const { vaultFactory, user, mockERC721, verifier } = ctx;

            // Start 3 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);
            const bundleId3 = await initializeBundle(vaultFactory, user);
            const bundleAddress3 = await vaultFactory.instanceAt(bundleId3);

            // Fund 2 bundles with different token IDs
            const tokenId = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress, tokenId);

            const tokenId2 = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress2, tokenId2);

            // Create predicate for a wildcard ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true
                },
            ];

            // First and second bundle should have item
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress)).to.be.true;
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress2)).to.be.true;

            // Third should not
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress3)).to.be.false;
        });

        it("fails to verify if a minimum amount for an ERC721 wildcard is not met", async () => {
            const { vaultFactory, user, mockERC721, verifier } = ctx;

            // Start 3 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);
            const bundleId3 = await initializeBundle(vaultFactory, user);
            const bundleAddress3 = await vaultFactory.instanceAt(bundleId3);

            // Fund 2 bundles with different token IDs
            const tokenId = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress, tokenId);

            const tokenId2 = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress2, tokenId2);

            // Create predicate for a wildcard ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: 1,
                    amount: 4,
                    anyIdAllowed: true
                },
            ];

            // No bundles should have enough items - specified 4
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress)).to.be.false;
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress2)).to.be.false;
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress3)).to.be.false;
        });

        it("verifies a specific ERC721 for any token id with a minimum amount", async () => {
            const { vaultFactory, user, mockERC721, verifier } = ctx;

            // Start 3 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);
            const bundleId3 = await initializeBundle(vaultFactory, user);
            const bundleAddress3 = await vaultFactory.instanceAt(bundleId3);

            // Fund 2 bundles with different token IDs
            const tokenId = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress, tokenId);

            // Fund 3 more to bundle 1
            await Promise.all([
                mint721ToAddress(mockERC721, bundleAddress),
                mint721ToAddress(mockERC721, bundleAddress),
                mint721ToAddress(mockERC721, bundleAddress)
            ]);

            const tokenId2 = await mint721(mockERC721, user);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress2, tokenId2);

            // Create predicate for a wildcard ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: 1,
                    amount: 4,
                    anyIdAllowed: true
                },
            ];

            // First bundle should have enough items (4)
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress)).to.be.true;

            // Second bundle should only have 1 item - not enough
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress2)).to.be.false;

            // Third should not - has 0 items
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress3)).to.be.false;
        });

        it("verifies a specific ERC1155 and token id with a minimum amount", async () => {
            const { vaultFactory, user, mockERC1155, verifier } = ctx;

            // Start 3 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);
            const bundleId3 = await initializeBundle(vaultFactory, user);
            const bundleAddress3 = await vaultFactory.instanceAt(bundleId3);

            // Fund a bundle with correct token ID and sufficient amount
            // Fund a bundle with correct token ID not enough amount
            // Fund a bundle with incorrect token ID
            const tokenId = await mint1155(mockERC1155, user, BigNumber.from(10));
            const tokenId2 = await mint1155(mockERC1155, user, BigNumber.from(10));

            await mockERC1155.connect(user).safeTransferFrom(user.address, bundleAddress, tokenId, 7, Buffer.from(""));
            await mockERC1155.connect(user).safeTransferFrom(user.address, bundleAddress2, tokenId, 3, Buffer.from(""));
            await mockERC1155
                .connect(user)
                .safeTransferFrom(user.address, bundleAddress3, tokenId2, 10, Buffer.from(""));

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 1,
                    asset: mockERC1155.address,
                    tokenId,
                    amount: 5,
                    anyIdAllowed: false
                },
            ];

            // First bundle should have item
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress)).to.be.true;
            // Second bundle should not have enough
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress2)).to.be.false;
            // Third bundle has wrong ID
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress3)).to.be.false;
        });

        it("verifies a minimum ERC20 amount", async () => {
            const { vaultFactory, user, mockERC20, verifier } = ctx;

            // Start 2 bundles
            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);

            // Fund a bundle with sufficient amount
            // Fund a bundle with not enough amount
            await mint20(mockERC20, user, 1000);

            await mockERC20.connect(user).transfer(bundleAddress, 1000);

            // Create predicate for a single ID
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: mockERC20.address,
                    tokenId: 0, // Ignored for 20
                    amount: 500,
                    anyIdAllowed: false
                },
            ];

            // First bundle should have item
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress)).to.be.true;
            // Second bundle should not have enough
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress2)).to.be.false;
        });

        it("verifies a combination of multiple items", async () => {
            const { vaultFactory, deployer, user, mockERC20, mockERC721, mockERC1155, verifier } = ctx;

            const mockERC20_2 = <MockERC20>await deploy("MockERC20", deployer, ["Mock ERC20", "MOCK"]);
            const mockERC721_2 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);
            const mockERC1155_2 = <MockERC1155>await deploy("MockERC1155", deployer, []);

            const bundleId = await initializeBundle(vaultFactory, user);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, user);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);

            // Mint all tokens
            await mint20(mockERC20, user, BigNumber.from(1000));
            await mint20(mockERC20_2, user, BigNumber.from(1000));

            const token721Id = await mint721(mockERC721, user);
            const token721Id2 = await mint721(mockERC721, user);
            const token721_2Id = await mint721(mockERC721_2, user);

            const token1155Id = await mint1155(mockERC1155, user, BigNumber.from(100));
            const token1155Id2 = await mint1155(mockERC1155, user, BigNumber.from(100));
            const token1155_2Id = await mint1155(mockERC1155_2, user, BigNumber.from(100));

            // Send tokens to bundle
            await mockERC20.connect(user).transfer(bundleAddress, 1000);
            await mockERC20_2.connect(user).transfer(bundleAddress, 500);

            await mockERC721.connect(user).transferFrom(user.address, bundleAddress, token721Id);
            await mockERC721.connect(user).transferFrom(user.address, bundleAddress, token721Id2);
            await mockERC721_2.connect(user).transferFrom(user.address, bundleAddress, token721_2Id);

            await mockERC1155
                .connect(user)
                .safeTransferFrom(user.address, bundleAddress, token1155Id, 10, Buffer.from(""));
            await mockERC1155
                .connect(user)
                .safeTransferFrom(user.address, bundleAddress, token1155Id2, 15, Buffer.from(""));
            await mockERC1155_2
                .connect(user)
                .safeTransferFrom(user.address, bundleAddress, token1155_2Id, 50, Buffer.from(""));

            // Require:
            // 1000 of ERC20 token 1
            // 500 of ERC20 token 2
            // First token of ERC721 1
            // Second token of ERC721 1
            // Any 1 token of ERC721 2
            // 10 of first token of ERC1155 1
            // 15 of second token of ERC1155 1
            // 50 of second token of ERC1155 2
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: mockERC20.address,
                    tokenId: 0,
                    amount: 1000,
                    anyIdAllowed: false
                },
                {
                    cType: 2,
                    asset: mockERC20_2.address,
                    tokenId: 0,
                    amount: 500,
                    anyIdAllowed: false
                },
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: token721Id,
                    amount: 1,
                    anyIdAllowed: false
                },
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: token721Id2,
                    amount: 1,
                    anyIdAllowed: false
                },
                {
                    cType: 0,
                    asset: mockERC721_2.address,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true
                },
                {
                    cType: 1,
                    asset: mockERC1155.address,
                    tokenId: token1155Id,
                    amount: 10,
                    anyIdAllowed: false
                },
                {
                    cType: 1,
                    asset: mockERC1155.address,
                    tokenId: token1155Id2,
                    amount: 15,
                    anyIdAllowed: false
                },
                {
                    cType: 1,
                    asset: mockERC1155_2.address,
                    tokenId: token1155_2Id,
                    amount: 50,
                    anyIdAllowed: false
                },
            ];

            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress)).to.be.true;
            expect(await verifier.verifyPredicates(encodeSignatureItems(signatureItems), bundleAddress2)).to.be.false;
        });
    });
});
