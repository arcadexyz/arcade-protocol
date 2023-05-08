import { expect } from "chai";
import hre, { waffle } from "hardhat";
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
} from "../typechain";
import { deploy } from "./utils/contracts";
import { LoanTerms } from "./utils/types";
import { fromRpcSig } from "ethereumjs-util";

type Signer = SignerWithAddress;

const ORIGINATOR_ROLE = "0x59abfac6520ec36a6556b2a4dd949cc40007459bcd5cd2507f1e5cc77b6bc97e";
const REPAYER_ROLE = "0x9c60024347074fd9de2c1e36003080d22dbc76a41ef87444d21e361bcb39118e";

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

describe("PromissoryNote", () => {
    // ========== HELPER FUNCTIONS ===========
    // Create Loan Terms
    const createLoanTerms = (
        payableCurrency: string,
        collateralAddress: string,
        {
            durationSecs = BigNumber.from(360000),
            principal = hre.ethers.utils.parseEther("100"),
            proratedInterestRate = hre.ethers.utils.parseEther("1"),
            collateralId = 1,
            deadline = 259200,
        }: Partial<LoanTerms> = {},
    ): LoanTerms => {
        return {
            durationSecs,
            principal,
            proratedInterestRate,
            collateralId,
            collateralAddress,
            payableCurrency,
            deadline,
        };
    };

    // Context / Fixture
    const fixture = async (): Promise<TestContext> => {
        const signers: Signer[] = await hre.ethers.getSigners();

        const whitelist = <CallWhitelist>await deploy("CallWhitelist", signers[0], []);
        const vaultTemplate = <AssetVault>await deploy("AssetVault", signers[0], []);
        const feeController = <FeeController>await deploy("FeeController", signers[0], []);

        const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address]);

        const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);


        const borrowerNote = <PromissoryNote>(
            await deploy("PromissoryNote", signers[0], ["Arcade.xyz BorrowerNote", "aBN"])
        );
        const lenderNote = <PromissoryNote>await deploy("PromissoryNote", signers[0], ["Arcade.xyz LenderNote", "aLN"]);

        const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [borrowerNote.address, lenderNote.address]);

        // Grant correct permissions for promissory note
        // Giving to user to call PromissoryNote functions directly
        for (const note of [borrowerNote, lenderNote]) {
            await note.connect(signers[0]).initialize(signers[0].address);
        }

        const originationController = <OriginationController>await deploy(
            "OriginationController", signers[0], [loanCore.address, feeController.address]
        )
        await originationController.deployed();

        const originator = signers[0];
        const repayer = signers[0];

        await loanCore.connect(signers[0]).grantRole(ORIGINATOR_ROLE, await originator.getAddress());
        await loanCore.connect(signers[0]).grantRole(REPAYER_ROLE, await repayer.getAddress());

        const repaymentController = <RepaymentController>(
            await deploy("RepaymentController", signers[0], [loanCore.address, feeController.address])
        );
        await repaymentController.deployed();
        const updateRepaymentControllerPermissions = await loanCore.grantRole(
            REPAYER_ROLE,
            repaymentController.address,
        );
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
        const transaction = await note.mint(await user.getAddress(), totalSupply);
        const receipt = await transaction.wait();

        if (receipt && receipt.events && receipt.events.length === 1 && receipt.events[0].args) {
            return receipt.events[0].args.tokenId;
        } else {
            throw new Error("Unable to mint promissory note");
        }
    };

    // ========== PROMISSORY NOTE TESTS ===========
    describe("constructor", () => {
        it("Creates a PromissoryNote", async () => {
            const signers: Signer[] = await hre.ethers.getSigners();

            const PromissoryNote = <PromissoryNote>await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN"]);

            expect(PromissoryNote).exist;
        });

        it("fails to initialize if not called by the deployer", async () => {
            const { loanCore } = await loadFixture(fixture);
            const signers: Signer[] = await hre.ethers.getSigners();

            const PromissoryNote = <PromissoryNote>await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN"]);

            await expect(PromissoryNote.connect(signers[1]).initialize(loanCore.address)).to.be.revertedWith(
                "PN_CannotInitialize",
            );
        });

        it("fails to initialize if already initialized", async () => {
            const { loanCore } = await loadFixture(fixture);
            const signers: Signer[] = await hre.ethers.getSigners();

            const PromissoryNote = <PromissoryNote>await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN"]);

            await expect(PromissoryNote.connect(signers[0]).initialize(loanCore.address)).to.not.be.reverted;

            // Try to call again
            await expect(PromissoryNote.connect(signers[0]).initialize(loanCore.address)).to.be.revertedWith(
                "PN_AlreadyInitialized",
            );
        });
    });

    describe("mint", () => {
        it("Reverts if sender is not an assigned minter", async () => {
            const { lenderPromissoryNote: promissoryNote, user, other } = await loadFixture(fixture);
            const transaction = promissoryNote.connect(other).mint(await user.getAddress(), 1);
            await expect(transaction).to.be.revertedWith("PN_MintingRole");
        });

        it("Assigns a PromissoryNote NFT to the recipient", async () => {
            const { lenderPromissoryNote: promissoryNote, user, other } = await loadFixture(fixture);
            const transaction = await promissoryNote.connect(user).mint(await other.getAddress(), 1);
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

    describe("pause", () => {
        it("does not allow a non-admin to pause", async () => {
            const signers: Signer[] = await hre.ethers.getSigners();

            const PromissoryNote = <PromissoryNote>await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN"]);

            await expect(PromissoryNote.connect(signers[0]).initialize(signers[0].address)).to.not.be.reverted;

            await expect(PromissoryNote.connect(signers[1]).setPaused(true)).to.be.revertedWith(
                `AccessControl: account ${signers[1].address.toLowerCase()} is missing role 0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775`,
            );
        });

        it("does not allow a non-admin to unpause", async () => {
            const signers: Signer[] = await hre.ethers.getSigners();

            const PromissoryNote = <PromissoryNote>await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN"]);

            await expect(PromissoryNote.connect(signers[0]).initialize(signers[0].address)).to.not.be.reverted;

            await expect(PromissoryNote.connect(signers[1]).setPaused(false)).to.be.revertedWith(
                `AccessControl: account ${signers[1].address.toLowerCase()} is missing role 0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775`,
            );
        });

        it("allows an admin to pause", async () => {
            const signers: Signer[] = await hre.ethers.getSigners();

            const PromissoryNote = <PromissoryNote>await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN"]);

            await expect(PromissoryNote.connect(signers[0]).initialize(signers[0].address)).to.not.be.reverted;

            await expect(PromissoryNote.connect(signers[0]).setPaused(true))
                .to.emit(PromissoryNote, "Paused")
                .withArgs(signers[0].address);
        });

        it("allows an admin to unpause", async () => {
            const signers: Signer[] = await hre.ethers.getSigners();

            const PromissoryNote = <PromissoryNote>await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN"]);

            await expect(PromissoryNote.connect(signers[0]).initialize(signers[0].address)).to.not.be.reverted;

            await expect(PromissoryNote.connect(signers[0]).setPaused(true))
                .to.emit(PromissoryNote, "Paused")
                .withArgs(signers[0].address);

            await expect(PromissoryNote.connect(signers[0]).setPaused(false))
                .to.emit(PromissoryNote, "Unpaused")
                .withArgs(signers[0].address);
        });

        it("transfers revert on pause", async () => {
            const signers: Signer[] = await hre.ethers.getSigners();

            const PromissoryNote = <PromissoryNote>await deploy("PromissoryNote", signers[0], ["PromissoryNote", "BN"]);

            // Mint to first signer
            await expect(PromissoryNote.connect(signers[0]).initialize(signers[0].address)).to.not.be.reverted;

            await PromissoryNote.mint(signers[0].address, 1);

            // Pause
            await expect(PromissoryNote.connect(signers[0]).setPaused(true))
                .to.emit(PromissoryNote, "Paused")
                .withArgs(signers[0].address);

            // Try to transfer, should fail
            await expect(
                PromissoryNote.connect(signers[0]).transferFrom(signers[0].address, signers[1].address, 1),
            ).to.be.revertedWith("PN_ContractPaused");

            await expect(PromissoryNote.connect(signers[0]).setPaused(false))
                .to.emit(PromissoryNote, "Unpaused")
                .withArgs(signers[0].address);

            // After unpause, should transfer successfully
            await expect(PromissoryNote.connect(signers[0]).transferFrom(signers[0].address, signers[1].address, 1)).to
                .not.be.reverted;
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
        const maxDeadline = hre.ethers.constants.MaxUint256;

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
        let promissoryNoteId: BigNumberish;
        let signature: string;
        let v: number;
        let r: Buffer;
        let s: Buffer;

        beforeEach(async () => {
            ({ borrowerPromissoryNote: promissoryNote, user, other } = await loadFixture(fixture));
            promissoryNoteId = await mintPromissoryNote(promissoryNote, user);

            const data = buildData(
                chainId,
                promissoryNote.address,
                await promissoryNote.name(),
                "1",
                await user.getAddress(),
                await other.getAddress(),
                promissoryNoteId,
                0,
            );

            signature = await user._signTypedData(data.domain, data.types, data.message);
            ({ v, r, s } = fromRpcSig(signature));
        });

        it("should accept owner signature", async () => {
            let approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(hre.ethers.constants.AddressZero);

            await expect(
                promissoryNote.permit(
                    await user.getAddress(),
                    await other.getAddress(),
                    promissoryNoteId,
                    maxDeadline,
                    v,
                    r,
                    s,
                ),
            )
                .to.emit(promissoryNote, "Approval")
                .withArgs(await user.getAddress(), await other.getAddress(), promissoryNoteId);

            approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(await other.getAddress());
            //check nonce was incremented to one
            expect(await promissoryNote.nonces(await user.getAddress())).to.equal(1);
            //test coverage checking domain separator
            expect(await promissoryNote.DOMAIN_SEPARATOR());
        });

        it("rejects if given owner is not real owner", async () => {
            const approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(hre.ethers.constants.AddressZero);

            await expect(
                promissoryNote.permit(
                    await other.getAddress(),
                    await other.getAddress(),
                    promissoryNoteId,
                    maxDeadline,
                    v,
                    r,
                    s,
                ),
            ).to.be.revertedWith("ERC721P_NotTokenOwner");
        });

        it("rejects if promissoryNoteId is not valid", async () => {
            const approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(hre.ethers.constants.AddressZero);
            const otherNoteId = await mintPromissoryNote(promissoryNote, user);

            await expect(
                promissoryNote.permit(
                    await other.getAddress(),
                    await other.getAddress(),
                    otherNoteId,
                    maxDeadline,
                    v,
                    r,
                    s,
                ),
            ).to.be.revertedWith("ERC721P_NotTokenOwner");
        });

        it("rejects reused signature", async () => {
            await expect(
                promissoryNote.permit(
                    await user.getAddress(),
                    await other.getAddress(),
                    promissoryNoteId,
                    maxDeadline,
                    v,
                    r,
                    s,
                ),
            )
                .to.emit(promissoryNote, "Approval")
                .withArgs(await user.getAddress(), await other.getAddress(), promissoryNoteId);

            await expect(
                promissoryNote.permit(
                    await user.getAddress(),
                    await other.getAddress(),
                    promissoryNoteId,
                    maxDeadline,
                    v,
                    r,
                    s,
                ),
            ).to.be.revertedWith("ERC721P_InvalidSignature");
        });

        it("rejects other signature", async () => {
            const data = buildData(
                chainId,
                promissoryNote.address,
                await promissoryNote.name(),
                "1",
                await user.getAddress(),
                await other.getAddress(),
                promissoryNoteId,
                0,
            );

            const signature = await other._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            await expect(
                promissoryNote.permit(
                    await user.getAddress(),
                    await other.getAddress(),
                    promissoryNoteId,
                    maxDeadline,
                    v,
                    r,
                    s,
                ),
            ).to.be.revertedWith("ERC721P_InvalidSignature");
        });

        it("rejects expired signature", async () => {
            const data = buildData(
                chainId,
                promissoryNote.address,
                await promissoryNote.name(),
                "1",
                await user.getAddress(),
                await other.getAddress(),
                promissoryNoteId,
                0,
                BigNumber.from("1234"),
            );

            const signature = await user._signTypedData(data.domain, data.types, data.message);
            const { v, r, s } = fromRpcSig(signature);

            const approved = await promissoryNote.getApproved(promissoryNoteId);
            expect(approved).to.equal(hre.ethers.constants.AddressZero);

            await expect(
                promissoryNote.permit(
                    await user.getAddress(),
                    await other.getAddress(),
                    promissoryNoteId,
                    "1234",
                    v,
                    r,
                    s,
                ),
            ).to.be.revertedWith("ERC721P_DeadlineExpired");
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
