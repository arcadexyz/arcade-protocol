import chai, { expect } from "chai";
import hre, { waffle } from "hardhat";
import { solidity } from "ethereum-waffle";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

chai.use(solidity);

import { CallWhitelistApprovals, MockERC20, MockERC721, MockERC1155 } from "../typechain";
import { deploy } from "./utils/contracts";

import { WHITELIST_MANAGER_ROLE } from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    whitelist: CallWhitelistApprovals;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    mockERC1155: MockERC1155;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

describe("CallWhitelistApprovals", () => {
    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await hre.ethers.getSigners();
        const whitelist = <CallWhitelistApprovals>await deploy("CallWhitelistApprovals", signers[0], []);
        const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);
        const mockERC721 = <MockERC721>await deploy("MockERC721", signers[0], ["Mock ERC721", "MOCK"]);
        const mockERC1155 = <MockERC1155>await deploy("MockERC1155", signers[0], []);

        await whitelist.grantRole(WHITELIST_MANAGER_ROLE, signers[0].address);

        return {
            whitelist,
            mockERC20,
            mockERC721,
            mockERC1155,
            user: signers[0],
            other: signers[1],
            signers: signers.slice(2),
        };
    };

    describe("setApproval", () => {
        it("should succeed from whitelist manager", async () => {
            const { whitelist, mockERC20, user, other } = await loadFixture(fixture);

            await expect(whitelist.connect(user).setApproval(mockERC20.address, other.address, true))
                .to.emit(whitelist, "ApprovalSet")
                .withArgs(user.address, mockERC20.address, other.address, true);
        });

        it("should fail from non-whitelist manager", async () => {
            const { whitelist, mockERC20, other } = await loadFixture(fixture);

            await expect(whitelist.connect(other).setApproval(mockERC20.address, other.address, true))
                .to.be.revertedWith("AccessControl");
        });

        it("should succeed after role granted", async () => {
            const { whitelist, mockERC20, user, other } = await loadFixture(fixture);

            await expect(whitelist.connect(user).grantRole(WHITELIST_MANAGER_ROLE, other.address))
                .to.emit(whitelist, "RoleGranted")
                .withArgs(WHITELIST_MANAGER_ROLE, other.address, user.address);

            await expect(whitelist.connect(other).setApproval(mockERC20.address, other.address, true))
                .to.emit(whitelist, "ApprovalSet")
                .withArgs(other.address, mockERC20.address, other.address, true);
        });

        it("should fail from old address after role renounced", async () => {
            const { whitelist, mockERC20, user, other } = await loadFixture(fixture);

            await expect(whitelist.connect(user).renounceRole(WHITELIST_MANAGER_ROLE, user.address))
                .to.emit(whitelist, "RoleRevoked")
                .withArgs(WHITELIST_MANAGER_ROLE, user.address, user.address);

            await expect(whitelist.connect(user).setApproval(mockERC20.address, other.address, true))
                .to.be.revertedWith("AccessControl");
        });
    });

    describe("isApproved", () => {
        it("passes after adding to approvals", async () => {
            const { whitelist, mockERC20, other } = await loadFixture(fixture);

            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.false;
            await whitelist.setApproval(mockERC20.address, other.address, true);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.true;
        });

        it("fails after removing from approvals", async () => {
            const { whitelist, mockERC20, other } = await loadFixture(fixture);

            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.false;
            await whitelist.setApproval(mockERC20.address, other.address, true);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.true;
            await whitelist.setApproval(mockERC20.address, other.address, false);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.false;
        });

        it("adding twice is a noop", async () => {
            const { whitelist, mockERC20, other } = await loadFixture(fixture);

            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.false;
            await whitelist.setApproval(mockERC20.address, other.address, true);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.true;
            await whitelist.setApproval(mockERC20.address, other.address, true);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.true;
        });

        it("removing twice is a noop", async () => {
            const { whitelist, mockERC20, other } = await loadFixture(fixture);

            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.false;
            await whitelist.setApproval(mockERC20.address, other.address, true);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.true;
            await whitelist.setApproval(mockERC20.address, other.address, false);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.false;
            await whitelist.setApproval(mockERC20.address, other.address, false);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.false;
        });

        it("add again after removing", async () => {
            const { whitelist, mockERC20, other } = await loadFixture(fixture);

            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.false;
            await whitelist.setApproval(mockERC20.address, other.address, true);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.true;
            await whitelist.setApproval(mockERC20.address, other.address, false);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.false;
            await whitelist.setApproval(mockERC20.address, other.address, true);
            expect(await whitelist.isApproved(mockERC20.address, other.address)).to.be.true;
        });
    });
});
