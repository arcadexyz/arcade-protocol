import chai, { expect } from "chai";
import hre, { waffle } from "hardhat";
import { solidity } from "ethereum-waffle";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

chai.use(solidity);

import { CallWhitelistDelegation, DelegationRegistry, MockERC20, MockERC721, MockERC1155 } from "../typechain";
import { deploy } from "./utils/contracts";
import { ADMIN_ROLE, WHITELIST_MANAGER_ROLE } from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    whitelist: CallWhitelistDelegation;
    registry: DelegationRegistry;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    mockERC1155: MockERC1155;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

describe("CallWhitelistDelegation", () => {
    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await hre.ethers.getSigners();
        const registry = <DelegationRegistry>await deploy("DelegationRegistry", signers[0], []);
        const whitelist = <CallWhitelistDelegation>await deploy("CallWhitelistDelegation", signers[0], [registry.address]);
        const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);
        const mockERC721 = <MockERC721>await deploy("MockERC721", signers[0], ["Mock ERC721", "MOCK"]);
        const mockERC1155 = <MockERC1155>await deploy("MockERC1155", signers[0], []);

        await whitelist.grantRole(WHITELIST_MANAGER_ROLE, signers[0].address);

        return {
            registry,
            whitelist,
            mockERC20,
            mockERC721,
            mockERC1155,
            user: signers[0],
            other: signers[1],
            signers: signers.slice(2),
        };
    };

    describe("constructor", () => {
        it("fails to deploy if the delegate registry is the zero address", async () => {
            const factory = await hre.ethers.getContractFactory("CallWhitelistDelegation");

            await expect(factory.deploy(hre.ethers.constants.AddressZero)).to.be.revertedWith(
                "CWD_ZeroAddress"
            );
        });
    });

    describe("setDelegationApproval", () => {
        it("should succeed from whitelist manager", async () => {
            const { whitelist, mockERC20, user } = await loadFixture(fixture);

            await expect(whitelist.connect(user).setDelegationApproval(mockERC20.address, true))
                .to.emit(whitelist, "DelegationSet")
                .withArgs(user.address, mockERC20.address, true);
        });

        it("should fail from non-whitelist manager", async () => {
            const { whitelist, mockERC20, other } = await loadFixture(fixture);

            await expect(whitelist.connect(other).setDelegationApproval(mockERC20.address, true))
                .to.be.revertedWith("AccessControl");
        });

        it("should succeed after role granted", async () => {
            const { whitelist, mockERC20, user, other } = await loadFixture(fixture);

            await expect(whitelist.connect(user).grantRole(WHITELIST_MANAGER_ROLE, other.address))
                .to.emit(whitelist, "RoleGranted")
                .withArgs(WHITELIST_MANAGER_ROLE, other.address, user.address);

            await expect(whitelist.connect(other).setDelegationApproval(mockERC20.address, true))
                .to.emit(whitelist, "DelegationSet")
                .withArgs(other.address, mockERC20.address, true);
        });

        it("should fail from old address after role renounced", async () => {
            const { whitelist, mockERC20, user } = await loadFixture(fixture);

            await expect(whitelist.connect(user).renounceRole(WHITELIST_MANAGER_ROLE, user.address))
                .to.emit(whitelist, "RoleRevoked")
                .withArgs(WHITELIST_MANAGER_ROLE, user.address, user.address);

            await expect(whitelist.connect(user).setDelegationApproval(mockERC20.address, true))
                .to.be.revertedWith("AccessControl");
        });
    });

    describe("setRegistry", () => {
        it("should succeed from admin", async () => {
            const { whitelist, user, other } = await loadFixture(fixture);

            await expect(whitelist.connect(user).setRegistry(other.address))
                .to.emit(whitelist, "RegistryChanged")
                .withArgs(user.address, other.address);
        });

        it("should fail from non-admin", async () => {
            const { whitelist, other } = await loadFixture(fixture);

            await expect(whitelist.connect(other).setRegistry(other.address))
                .to.be.revertedWith("AccessControl");
        });

        it("should fail from whitelist manager", async () => {
            const { whitelist, user, other } = await loadFixture(fixture);

            await expect(whitelist.connect(user).grantRole(WHITELIST_MANAGER_ROLE, other.address))
                .to.emit(whitelist, "RoleGranted")
                .withArgs(WHITELIST_MANAGER_ROLE, other.address, user.address);

            await expect(whitelist.connect(other).setRegistry(other.address))
                .to.be.revertedWith("AccessControl");
        });

        it("should fail if same address is used", async () => {
            const { whitelist, user, other } = await loadFixture(fixture);

            await expect(whitelist.connect(user).setRegistry(other.address))
                .to.emit(whitelist, "RegistryChanged")
                .withArgs(user.address, other.address);

            await expect(whitelist.connect(user).setRegistry(other.address))
                .to.be.revertedWith("CWD_RegistryAlreadySet()");
        });

        it("should succeed after role granted", async () => {
            const { whitelist, user, other } = await loadFixture(fixture);

            await expect(whitelist.connect(user).grantRole(ADMIN_ROLE, other.address))
                .to.emit(whitelist, "RoleGranted")
                .withArgs(ADMIN_ROLE, other.address, user.address);

            await expect(whitelist.connect(other).setRegistry(other.address))
                .to.emit(whitelist, "RegistryChanged")
                .withArgs(other.address, other.address);
        });

        it("should fail from old address after role renounced", async () => {
            const { whitelist, user, other } = await loadFixture(fixture);

            await expect(whitelist.connect(user).renounceRole(ADMIN_ROLE, user.address))
                .to.emit(whitelist, "RoleRevoked")
                .withArgs(ADMIN_ROLE, user.address, user.address);

            await expect(whitelist.connect(user).setRegistry(other.address))
                .to.be.revertedWith("AccessControl");
        });
    });

    describe("isDelegationApproved", () => {
        it("passes after adding to approvals", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);

            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.false;
            await whitelist.setDelegationApproval(mockERC20.address, true);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.true;
        });

        it("fails after removing from approvals", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);

            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.false;
            await whitelist.setDelegationApproval(mockERC20.address, true);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.true;
            await whitelist.setDelegationApproval(mockERC20.address, false);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.false;
        });

        it("adding twice is a noop", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);

            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.false;
            await whitelist.setDelegationApproval(mockERC20.address, true);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.true;
            await whitelist.setDelegationApproval(mockERC20.address, true);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.true;
        });

        it("removing twice is a noop", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);

            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.false;
            await whitelist.setDelegationApproval(mockERC20.address, true);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.true;
            await whitelist.setDelegationApproval(mockERC20.address, false);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.false;
            await whitelist.setDelegationApproval(mockERC20.address, false);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.false;
        });

        it("add again after removing", async () => {
            const { whitelist, mockERC20 } = await loadFixture(fixture);

            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.false;
            await whitelist.setDelegationApproval(mockERC20.address, true);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.true;
            await whitelist.setDelegationApproval(mockERC20.address, false);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.false;
            await whitelist.setDelegationApproval(mockERC20.address, true);
            expect(await whitelist.isDelegationApproved(mockERC20.address)).to.be.true;
        });
    });
});
