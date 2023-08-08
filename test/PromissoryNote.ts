import { expect } from "chai";
import hre, { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber, BigNumberish } from "ethers";

import {
    OriginationController,
    MockERC20,
    LoanCore,
    PromissoryNote,
    CallWhitelist,
    VaultFactory,
    AssetVault,
    FeeController,
    RepaymentController,
    BaseURIDescriptor,
} from "../typechain";

import { deploy } from "./utils/contracts";
import { LoanTerms } from "./utils/types";
import { fromRpcSig } from "ethereumjs-util";

type Signer = SignerWithAddress;

import { ORIGINATOR_ROLE, REPAYER_ROLE, BASE_URI, RESOURCE_MANAGER_ROLE } from "./utils/constants";
import { ZERO_ADDRESS } from "./utils/erc20";
import { Test } from "mocha";

interface TestContext {
    borrowerPromissoryNote: PromissoryNote;
    lenderPromissoryNote: PromissoryNote;
    loanCore: LoanCore;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    vaultFactory: VaultFactory;
    mockERC20: MockERC20;
    repayer: Signer;
    originator: Signer;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

// Context / Fixture
const fixture = async (): Promise<TestContext> => {
    const signers: Signer[] = await ethers.getSigners();

    const whitelist = <CallWhitelist>await deploy("CallWhitelist", signers[0], []);
    const vaultTemplate = <AssetVault>await deploy("AssetVault", signers[0], []);
    const feeController = <FeeController>await deploy("FeeController", signers[0], []);
    const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI]);
    const vaultFactory = <VaultFactory>(
        await deploy("VaultFactory", signers[0], [
            vaultTemplate.address,
            whitelist.address,
            feeController.address,
            descriptor.address,
        ])
    );

    const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);

    const borrowerNote = <PromissoryNote>(
        await deploy("PromissoryNote", signers[0], ["Arcade.xyz BorrowerNote", "aBN", descriptor.address])
    );
    const lenderNote = <PromissoryNote>(
        await deploy("PromissoryNote", signers[0], ["Arcade.xyz LenderNote", "aLN", descriptor.address])
    );

    const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [borrowerNote.address, lenderNote.address]);

    // Grant correct permissions for promissory note
    // Giving to user to call PromissoryNote functions directly
    for (const note of [borrowerNote, lenderNote]) {
        await note.connect(signers[0]).initialize(signers[0].address);
    }

    const originationController = <OriginationController>(
        await deploy("OriginationController", signers[0], [loanCore.address, feeController.address])
    );
    await originationController.deployed();

    const originator = signers[0];
    const repayer = signers[0];

    await loanCore.connect(signers[0]).grantRole(ORIGINATOR_ROLE, await originator.address);
    await loanCore.connect(signers[0]).grantRole(REPAYER_ROLE, await repayer.address);

    const repaymentController = <RepaymentController>(
        await deploy("RepaymentController", signers[0], [loanCore.address, feeController.address])
    );
    await repaymentController.deployed();
    const updateRepaymentControllerPermissions = await loanCore.grantRole(REPAYER_ROLE, repaymentController.address);
    await updateRepaymentControllerPermissions.wait();

    return {
        borrowerPromissoryNote: borrowerNote,
        lenderPromissoryNote: lenderNote,
        loanCore,
        repaymentController,
        originationController,
        vaultFactory,
        mockERC20,
        repayer,
        originator,
        user: signers[0],
        other: signers[1],
        signers: signers.slice(2),
    };
};

// Mint Promissory Note
const mintPromissoryNote = async (note: PromissoryNote, user: Signer): Promise<BigNumber> => {
    const totalSupply = await note.totalSupply();
    const transaction = await note.mint(user.address, totalSupply);
    const receipt = await transaction.wait();

    if (receipt && receipt.events && receipt.events.length === 1 && receipt.events[0].args) {
        return receipt.events[0].args.tokenId;
    } else {
        throw new Error("Unable to mint promissory note");
    }
};

describe("PromissoryNote", () => {
    describe("constructor", () => {
        it("Reverts if descriptor address not provided", async () => {
            const RepaymentController = await ethers.getContractFactory("PromissoryNote");
            await expect(RepaymentController.deploy("PromissoryNote", "BN", ZERO_ADDRESS)).to.be.revertedWith(
                "PN_ZeroAddress",
            );
        });

        it("Creates a PromissoryNote", async () => {
            const signers: Signer[] = await ethers.getSigners();
            const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI]);

            const promissoryNote = <PromissoryNote>(
                await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN", descriptor.address])
            );

            expect(promissoryNote).to.exist;
        });

        it("fails to initialize if not called by the deployer", async () => {
            const { loanCore } = await loadFixture(fixture);
            const signers: Signer[] = await ethers.getSigners();
            const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI]);

            const promissoryNote = <PromissoryNote>(
                await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN", descriptor.address])
            );

            await expect(promissoryNote.connect(signers[1]).initialize(loanCore.address)).to.be.revertedWith(
                "AccessControl",
            );
        });

        it("fails to initialize if already initialized", async () => {
            const { loanCore } = await loadFixture(fixture);
            const signers: Signer[] = await ethers.getSigners();
            const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI]);

            const promissoryNote = <PromissoryNote>(
                await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN", descriptor.address])
            );

            await expect(promissoryNote.connect(signers[0]).initialize(loanCore.address)).to.not.be.reverted;

            // Try to call again
            await expect(promissoryNote.connect(signers[0]).initialize(loanCore.address)).to.be.revertedWith(
                "AccessControl",
            );
        });
    });

    describe("mint", () => {
        it("Reverts if sender is not an assigned minter", async () => {
            const { lenderPromissoryNote: promissoryNote, user, other } = await loadFixture(fixture);
            const transaction = promissoryNote.connect(other).mint(user.address, 1);
            await expect(transaction).to.be.revertedWith("PN_MintingRole");
        });

        it("Assigns a PromissoryNote NFT to the recipient", async () => {
            const { lenderPromissoryNote: promissoryNote, user, other } = await loadFixture(fixture);
            const transaction = await promissoryNote.connect(user).mint(other.address, 1);
            const receipt = await transaction.wait();

            if (receipt && receipt.events && receipt.events.length === 1 && receipt.events[0].args) {
                return expect(receipt.events[0]).exist;
            } else {
                throw new Error("Unable to mint promissory note");
            }
        });
    });

    describe("burn", () => {
        it("Reverts if sender does not own the note", async () => {
            const { borrowerPromissoryNote: promissoryNote, user, other } = await loadFixture(fixture);

            const promissoryNoteId = await mintPromissoryNote(promissoryNote, user);
            await expect(promissoryNote.connect(other).burn(promissoryNoteId)).to.be.revertedWith("PN_BurningRole");
        });

        it("Burns a PromissoryNote NFT", async () => {
            const { borrowerPromissoryNote: promissoryNote, user } = await loadFixture(fixture);

            const promissoryNoteId = await mintPromissoryNote(promissoryNote, user);
            await expect(promissoryNote.connect(user).burn(promissoryNoteId)).to.not.be.reverted;
        });
    });

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
        const maxDeadline = ethers.constants.MaxUint256;

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

        let promissoryNote: PromissoryNote;
        let user: Signer;
        let other: Signer;
        let signers: Signer[];
        let promissoryNoteId: BigNumberish;
        let signature: string;
        let v: number;
        let r: Buffer;
        let s: Buffer;

        beforeEach(async () => {
            ({ borrowerPromissoryNote: promissoryNote, user, other, signers } = await loadFixture(fixture));
            promissoryNoteId = await mintPromissoryNote(promissoryNote, user);

            const data = buildData(
                chainId,
                promissoryNote.address,
                await promissoryNote.name(),
                "1",
                user.address,
                other.address,
                promissoryNoteId,
                0,
            );

            signature = await user._signTypedData(data.domain, data.types, data.message);
            ({ v, r, s } = fromRpcSig(signature));
        });

        it("should accept owner signature", async () => {
            let approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(ethers.constants.AddressZero);

            await expect(promissoryNote.permit(user.address, other.address, promissoryNoteId, maxDeadline, v, r, s))
                .to.emit(promissoryNote, "Approval")
                .withArgs(user.address, other.address, promissoryNoteId);

            approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(other.address);
            //check nonce was incremented to one
            expect(await promissoryNote.nonces(user.address)).to.equal(1);
            //test coverage checking domain separator
            expect(await promissoryNote.DOMAIN_SEPARATOR());
        });

        it("should accept signature from approved operator", async () => {
            let approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(ethers.constants.AddressZero);

            await promissoryNote.connect(user).setApprovalForAll(other.address, true);

            const data = buildData(
                chainId,
                promissoryNote.address,
                await promissoryNote.name(),
                "1",
                other.address,
                signers[0].address,
                promissoryNoteId,
                0,
            );

            signature = await other._signTypedData(data.domain, data.types, data.message);
            ({ v, r, s } = fromRpcSig(signature));

            await expect(
                promissoryNote.permit(
                    other.address,
                    signers[0].address,
                    promissoryNoteId,
                    maxDeadline,
                    v,
                    r,
                    s,
                ),
            )
                .to.emit(promissoryNote, "Approval")
                .withArgs(user.address, signers[0].address, promissoryNoteId);

            approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(signers[0].address);
            //check nonce was incremented to one
            expect(await promissoryNote.nonces(user.address)).to.equal(0);
            expect(await promissoryNote.nonces(other.address)).to.equal(1);
            //test coverage checking domain separator
            expect(await promissoryNote.DOMAIN_SEPARATOR());
        });

        it("rejects if given owner is not real owner", async () => {
            const approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(ethers.constants.AddressZero);

            await expect(
                promissoryNote.permit(other.address, other.address, promissoryNoteId, maxDeadline, v, r, s),
            ).to.be.revertedWith("ERC721P_NotTokenOwner");
        });

        it("rejects if promissoryNoteId is not valid", async () => {
            const approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(ethers.constants.AddressZero);
            const otherNoteId = await mintPromissoryNote(promissoryNote, user);

            await expect(
                promissoryNote.permit(other.address, other.address, otherNoteId, maxDeadline, v, r, s),
            ).to.be.revertedWith("ERC721P_NotTokenOwner");
        });

        it("rejects reused signature", async () => {
            await expect(promissoryNote.permit(user.address, other.address, promissoryNoteId, maxDeadline, v, r, s))
                .to.emit(promissoryNote, "Approval")
                .withArgs(user.address, other.address, promissoryNoteId);

            await expect(
                promissoryNote.permit(user.address, other.address, promissoryNoteId, maxDeadline, v, r, s),
            ).to.be.revertedWith("ERC721P_InvalidSignature");
        });

        it("rejects other signature", async () => {
            const data = buildData(
                chainId,
                promissoryNote.address,
                await promissoryNote.name(),
                "1",
                user.address,
                other.address,
                promissoryNoteId,
                0,
            );

            const signature = await other._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            await expect(
                promissoryNote.permit(user.address, other.address, promissoryNoteId, maxDeadline, v, r, s),
            ).to.be.revertedWith("ERC721P_InvalidSignature");
        });

        it("rejects expired signature", async () => {
            const data = buildData(
                chainId,
                promissoryNote.address,
                await promissoryNote.name(),
                "1",
                user.address,
                other.address,
                promissoryNoteId,
                0,
                BigNumber.from("1234"),
            );

            const signature = await user._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            const approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(ethers.constants.AddressZero);

            await expect(
                promissoryNote.permit(user.address, other.address, promissoryNoteId, "1234", v, r, s),
            ).to.be.revertedWith("ERC721P_DeadlineExpired");
        });
    });

    describe("Resource management", () => {
        let ctx: TestContext;
        let newDescriptor: BaseURIDescriptor;
        // const otherBaseURI = "https://example.com/";
        const otherBaseURI = BASE_URI;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const [deployer] = await ethers.getSigners();

            newDescriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", deployer, [otherBaseURI]);
            await newDescriptor.deployed();

            expect(await newDescriptor.baseURI()).to.be.eq(otherBaseURI);
        });

        it("gets the tokenURI", async () => {
            const { lenderPromissoryNote: promissoryNote, user, other } = ctx;

            await promissoryNote.connect(user).mint(other.address, 1);
            expect(await promissoryNote.tokenURI(1)).to.be.eq(`${BASE_URI}1`);
        });

        it("reverts if the tokenURI does not exist", async () => {
            const { lenderPromissoryNote: promissoryNote } = ctx;
            const tokenId = 1;

            await expect(promissoryNote.tokenURI(tokenId)).to.be.revertedWith(`PN_DoesNotExist(${tokenId})`);
        });

        it("reverts if non-admin tries to change the descriptor", async () => {
            const { lenderPromissoryNote: promissoryNote, other } = ctx;

            await expect(promissoryNote.connect(other).setDescriptor(newDescriptor.address)).to.be.revertedWith(
                "AccessControl",
            );
        });

        it("reverts if descriptor is set to 0 address", async () => {
            const { lenderPromissoryNote: promissoryNote, other } = ctx;
            await promissoryNote.grantRole(RESOURCE_MANAGER_ROLE, other.address);

            await expect(promissoryNote.connect(other).setDescriptor(ZERO_ADDRESS)).to.be.revertedWith(
                `PN_ZeroAddress("descriptor")`,
            );
        });

        it("changes the descriptor", async () => {
            const { lenderPromissoryNote: promissoryNote, user, other } = ctx;
            await promissoryNote.grantRole(RESOURCE_MANAGER_ROLE, other.address);

            expect(await newDescriptor.baseURI()).to.be.eq(otherBaseURI);

            await expect(promissoryNote.connect(other).setDescriptor(newDescriptor.address))
                .to.emit(promissoryNote, "SetDescriptor")
                .withArgs(other.address, newDescriptor.address);

            expect(await newDescriptor.baseURI()).to.be.eq(otherBaseURI);

            await promissoryNote.connect(user).mint(other.address, 1);
            expect(await promissoryNote.tokenURI(1)).to.be.eq(`${otherBaseURI}1`);
        });
    });

    describe("Introspection", function () {
        it("should return true for declaring support for eip165 interface contract", async () => {
            const { borrowerPromissoryNote } = await loadFixture(fixture);
            // https://eips.ethereum.org/EIPS/eip-165#test-cases
            expect(await borrowerPromissoryNote.supportsInterface("0x01ffc9a7")).to.be.true;
            expect(await borrowerPromissoryNote.supportsInterface("0xfafafafa")).to.be.false;
        });
    });
});
