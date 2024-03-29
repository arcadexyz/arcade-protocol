import { expect } from "chai";
import hre, { waffle } from "hardhat";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { CallWhitelist, MockERC20, MockERC721, MockERC1155, CryptoPunksMarket } from "../typechain";
import { deploy } from "./utils/contracts";

import { WHITELIST_MANAGER_ROLE } from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    whitelist: CallWhitelist;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    mockERC1155: MockERC1155;
    mockPunks: CryptoPunksMarket;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

describe("CallWhitelist", () => {
    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await hre.ethers.getSigners();
        const whitelist = <CallWhitelist>await deploy("CallWhitelist", signers[0], []);
        const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);
        const mockERC721 = <MockERC721>await deploy("MockERC721", signers[0], ["Mock ERC721", "MOCK"]);
        const mockERC1155 = <MockERC1155>await deploy("MockERC1155", signers[0], []);
        const mockPunks = <CryptoPunksMarket>await deploy("CryptoPunksMarket", signers[0], []);

        await whitelist.grantRole(WHITELIST_MANAGER_ROLE, signers[0].address);

        return {
            whitelist,
            mockERC20,
            mockERC721,
            mockERC1155,
            mockPunks,
            user: signers[0],
            other: signers[1],
            signers: signers.slice(2),
        };
    };

    describe("Access control", function () {
        describe("add", async () => {
            it("should succeed from whitelist manager", async () => {
                const { whitelist, mockERC20, user } = await loadFixture(fixture);

                const selector = mockERC20.interface.getSighash("mint");
                await expect(whitelist.connect(user).add(mockERC20.address, selector))
                    .to.emit(whitelist, "CallAdded")
                    .withArgs(user.address, mockERC20.address, selector);
            });

            it("should fail from non-whitelist manager", async () => {
                const { whitelist, mockERC20, other } = await loadFixture(fixture);

                const selector = mockERC20.interface.getSighash("mint");
                await expect(whitelist.connect(other).add(mockERC20.address, selector)).to.be.revertedWith(
                    "AccessControl",
                );
            });

            it("should succeed after role granted", async () => {
                const { whitelist, mockERC20, user, other } = await loadFixture(fixture);

                const selector = mockERC20.interface.getSighash("mint");

                await expect(whitelist.connect(user).grantRole(WHITELIST_MANAGER_ROLE, other.address))
                    .to.emit(whitelist, "RoleGranted")
                    .withArgs(WHITELIST_MANAGER_ROLE, other.address, user.address);

                await expect(whitelist.connect(other).add(mockERC20.address, selector))
                    .to.emit(whitelist, "CallAdded")
                    .withArgs(other.address, mockERC20.address, selector);
            });

            it("should fail from old address after role renounced", async () => {
                const { whitelist, mockERC20, user } = await loadFixture(fixture);

                const selector = mockERC20.interface.getSighash("mint");

                await expect(whitelist.connect(user).renounceRole(WHITELIST_MANAGER_ROLE, user.address))
                    .to.emit(whitelist, "RoleRevoked")
                    .withArgs(WHITELIST_MANAGER_ROLE, user.address, user.address);

                await expect(whitelist.connect(user).add(mockERC20.address, selector)).to.be.revertedWith(
                    "AccessControl",
                );
            });
        });

        describe("remove", async () => {
            it("should succeed from whitelist manager ", async () => {
                const { whitelist, mockERC20, user } = await loadFixture(fixture);

                const selector = mockERC20.interface.getSighash("mint");
                await expect(whitelist.connect(user).add(mockERC20.address, selector))
                    .to.emit(whitelist, "CallAdded")
                    .withArgs(user.address, mockERC20.address, selector);
                await expect(whitelist.connect(user).remove(mockERC20.address, selector))
                    .to.emit(whitelist, "CallRemoved")
                    .withArgs(user.address, mockERC20.address, selector);
            });

            it("should fail from non-whitelist manager", async () => {
                const { whitelist, mockERC20, user, other } = await loadFixture(fixture);

                const selector = mockERC20.interface.getSighash("mint");
                await expect(whitelist.connect(user).add(mockERC20.address, selector))
                    .to.emit(whitelist, "CallAdded")
                    .withArgs(user.address, mockERC20.address, selector);

                await expect(whitelist.connect(other).remove(mockERC20.address, selector)).to.be.revertedWith(
                    "AccessControl",
                );
            });

            it("should succeed after role granted", async () => {
                const { whitelist, mockERC20, user, other } = await loadFixture(fixture);

                const selector = mockERC20.interface.getSighash("mint");

                await expect(whitelist.connect(user).grantRole(WHITELIST_MANAGER_ROLE, other.address))
                    .to.emit(whitelist, "RoleGranted")
                    .withArgs(WHITELIST_MANAGER_ROLE, other.address, user.address);

                await expect(whitelist.connect(other).add(mockERC20.address, selector))
                    .to.emit(whitelist, "CallAdded")
                    .withArgs(other.address, mockERC20.address, selector);

                await expect(whitelist.connect(other).remove(mockERC20.address, selector))
                    .to.emit(whitelist, "CallRemoved")
                    .withArgs(other.address, mockERC20.address, selector);
            });

            it("should fail from old address after role renounced", async () => {
                const { whitelist, mockERC20, user } = await loadFixture(fixture);

                const selector = mockERC20.interface.getSighash("mint");

                await expect(whitelist.connect(user).add(mockERC20.address, selector))
                    .to.emit(whitelist, "CallAdded")
                    .withArgs(user.address, mockERC20.address, selector);

                await expect(whitelist.connect(user).renounceRole(WHITELIST_MANAGER_ROLE, user.address))
                    .to.emit(whitelist, "RoleRevoked")
                    .withArgs(WHITELIST_MANAGER_ROLE, user.address, user.address);

                await expect(whitelist.connect(user).remove(mockERC20.address, selector)).to.be.revertedWith(
                    "AccessControl"
                );
            });
        });
    });

    describe("Global blacklist", function () {
        it("erc20 transfer", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("transfer");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("erc20 approve", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("approve");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("erc20 transferFrom", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("transferFrom");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("erc20 increaseAllowance", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("increaseAllowance");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("erc721 transferFrom", async () => {
            const { whitelist, mockERC721 } = await loadFixture(fixture);
            const selector = mockERC721.interface.getSighash("transferFrom");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("erc721 safeTransferFrom", async () => {
            const { whitelist, mockERC721 } = await loadFixture(fixture);
            const selector = mockERC721.interface.getSighash("safeTransferFrom(address,address,uint256)");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("erc721 safeTransferFrom with data", async () => {
            const { whitelist, mockERC721 } = await loadFixture(fixture);
            const selector = mockERC721.interface.getSighash("safeTransferFrom(address,address,uint256,bytes)");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("erc721 setApprovalForAll", async () => {
            const { whitelist, mockERC721 } = await loadFixture(fixture);
            const selector = mockERC721.interface.getSighash("setApprovalForAll");
            expect(await whitelist.isWhitelisted(mockERC721.address, selector)).to.be.false;
        });

        it("erc1155 setApprovalForAll", async () => {
            const { whitelist, mockERC1155 } = await loadFixture(fixture);
            const selector = mockERC1155.interface.getSighash("setApprovalForAll");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("erc1155 safeTransferFrom", async () => {
            const { whitelist, mockERC1155 } = await loadFixture(fixture);
            const selector = mockERC1155.interface.getSighash("safeTransferFrom");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("erc1155 safeBatchTransferFrom", async () => {
            const { whitelist, mockERC1155 } = await loadFixture(fixture);
            const selector = mockERC1155.interface.getSighash("safeBatchTransferFrom");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("punks transferPunk", async () => {
            const { whitelist, mockPunks } = await loadFixture(fixture);
            const selector = mockPunks.interface.getSighash("transferPunk");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("punks offerPunkForSale", async () => {
            const { whitelist, mockPunks } = await loadFixture(fixture);
            const selector = mockPunks.interface.getSighash("offerPunkForSale");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("punks offerPunkForSaleToAddress", async () => {
            const { whitelist, mockPunks } = await loadFixture(fixture);
            const selector = mockPunks.interface.getSighash("offerPunkForSaleToAddress");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });

        it("punks buyPunk", async () => {
            const { whitelist, mockPunks } = await loadFixture(fixture);
            const selector = mockPunks.interface.getSighash("buyPunk");
            expect(await whitelist.isBlacklisted(selector)).to.be.true;
        });
    });

    describe("Whitelist", function () {
        it("doesn't override global blacklist", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("transfer");

            await whitelist.add(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.false;
        });

        it("passes after adding to whitelist", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("mint");

            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.false;
            await whitelist.add(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.true;
        });

        it("fails after removing to whitelist", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("mint");

            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.false;
            await whitelist.add(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.true;
            await whitelist.remove(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.false;
        });

        it("adding twice is a noop", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("mint");

            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.false;

            await whitelist.add(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.true;

            await expect(whitelist.add(mockERC20.address, selector))
                .to.be.revertedWith(`CW_AlreadyWhitelisted("${mockERC20.address}", "${selector}")`);
        });

        it("removing twice is a noop", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("mint");

            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.false;

            await whitelist.add(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.true;

            await whitelist.remove(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.false;

            await expect(whitelist.remove(mockERC20.address, selector))
                .to.be.revertedWith(`CW_NotWhitelisted("${mockERC20.address}", "${selector}")`);

        });

        it("add again after removing", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);
            const selector = mockERC20.interface.getSighash("mint");

            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.false;
            await whitelist.add(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.true;
            await whitelist.remove(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.false;
            await whitelist.add(mockERC20.address, selector);
            expect(await whitelist.isWhitelisted(mockERC20.address, selector)).to.be.true;
        });
    });
});
