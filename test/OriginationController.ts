import chai, { expect } from "chai";
import hre, { waffle, upgrades } from "hardhat";
import { solidity } from "ethereum-waffle";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber } from "ethers";
import { deploy } from "./utils/contracts";

chai.use(solidity);

import {
    OriginationController,
    CallWhitelist,
    MockERC20,
    MockERC721,
    VaultFactory,
    AssetVault,
    PromissoryNote,
    LoanCore,
    ArcadeItemsVerifier,
    FeeController,
    ERC1271LenderMock,
    MockOriginationController,
    ERC721Permit,
} from "../typechain";
import { approve, mint, ZERO_ADDRESS } from "./utils/erc20";
import { mint as mint721 } from "./utils/erc721";
import { BlockchainTime } from "./utils/time";
import { ItemsPredicate, LoanTerms, SignatureItem } from "./utils/types";
import { createLoanTermsSignature, createLoanItemsSignature, createPermitSignature } from "./utils/eip712";
import { encodePredicates, encodeSignatureItems, initializeBundle } from "./utils/loans";

const ORIGINATOR_ROLE = "0x59abfac6520ec36a6556b2a4dd949cc40007459bcd5cd2507f1e5cc77b6bc97e";
const ADMIN_ROLE = "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";

type Signer = SignerWithAddress;

interface TestContext {
    originationController: OriginationController;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    vaultFactory: VaultFactory;
    vault: AssetVault;
    lenderPromissoryNote: PromissoryNote;
    borrowerPromissoryNote: PromissoryNote;
    loanCore: LoanCore;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

/**
 * Creates a vault instance using the vault factory
 */
const createVault = async (factory: VaultFactory, user: Signer): Promise<AssetVault> => {
    const tx = await factory.connect(user).initializeBundle(await user.getAddress());
    const receipt = await tx.wait();

    let vault: AssetVault | undefined;
    if (receipt && receipt.events) {
        for (const event of receipt.events) {
            if (event.args && event.args.vault) {
                vault = <AssetVault>await hre.ethers.getContractAt("AssetVault", event.args.vault);
            }
        }
    } else {
        throw new Error("Unable to create new vault");
    }
    if (!vault) {
        throw new Error("Unable to create new vault");
    }
    return vault;
};

const fixture = async (): Promise<TestContext> => {
    const signers: Signer[] = await hre.ethers.getSigners();
    const [deployer] = signers;

    const feeController = <FeeController>await deploy("FeeController", signers[0], []);

    const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", deployer, ["Arcade.xyz BorrowerNote", "aBN"]);
    const lenderNote = <PromissoryNote>await deploy("PromissoryNote", deployer, ["Arcade.xyz LenderNote", "aLN"]);

    const LoanCore = await hre.ethers.getContractFactory("LoanCore");
    const loanCore = <LoanCore>await upgrades.deployProxy(
        LoanCore,
        [feeController.address, borrowerNote.address, lenderNote.address],
        {
            kind: "uups",
        },
    );

    // Grant correct permissions for promissory note
    for (const note of [borrowerNote, lenderNote]) {
        await note.connect(deployer).initialize(loanCore.address);
    }

    const whitelist = <CallWhitelist>await deploy("CallWhitelist", deployer, []);
    const vaultTemplate = <AssetVault>await deploy("AssetVault", deployer, []);

    const VaultFactoryFactory = await hre.ethers.getContractFactory("VaultFactory");
    const vaultFactory = <VaultFactory>(
        await upgrades.deployProxy(VaultFactoryFactory, [vaultTemplate.address, whitelist.address], { kind: "uups" })
    );
    const vault = await createVault(vaultFactory, signers[0]);

    const mockERC20 = <MockERC20>await deploy("MockERC20", deployer, ["Mock ERC20", "MOCK"]);
    const mockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);

    const OriginationController = await hre.ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>(
        await upgrades.deployProxy(OriginationController, [loanCore.address], { kind: "uups" })
    );
    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    return {
        originationController,
        mockERC20,
        mockERC721,
        vaultFactory,
        vault,
        lenderPromissoryNote: lenderNote,
        borrowerPromissoryNote: borrowerNote,
        loanCore,
        user: deployer,
        other: signers[1],
        signers: signers.slice(2),
    };
};

const createLoanTermsExpired = (
    payableCurrency: string,
    collateralAddress: string,
    {
        durationSecs = BigNumber.from(360000),
        principal = hre.ethers.utils.parseEther("100"),
        interestRate = hre.ethers.utils.parseEther("1"),
        collateralId = "1",
        numInstallments = 0,
        deadline = 808113600, // August 11, 1995
    }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        interestRate,
        collateralId,
        collateralAddress,
        payableCurrency,
        numInstallments,
        deadline,
    };
};

const createLoanTerms = (
    payableCurrency: string,
    collateralAddress: string,
    {
        durationSecs = BigNumber.from(360000),
        principal = hre.ethers.utils.parseEther("100"),
        interestRate = hre.ethers.utils.parseEther("1"),
        collateralId = "1",
        numInstallments = 0,
        deadline = 1754884800,
    }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        interestRate,
        collateralId,
        collateralAddress,
        payableCurrency,
        numInstallments,
        deadline,
    };
};

const maxDeadline = hre.ethers.constants.MaxUint256;

describe("OriginationController", () => {
    describe("initializer", () => {
        it("Reverts if _loanCore address is not provided", async () => {
            const OriginationController = await hre.ethers.getContractFactory("OriginationController");
            await expect(upgrades.deployProxy(OriginationController, [ZERO_ADDRESS])).to.be.revertedWith(
                "OC_ZeroAddress",
            );
        });

        it("Instantiates the OriginationController", async () => {
            const signers: Signer[] = await hre.ethers.getSigners();
            const [deployer] = signers;

            const loanCore = <LoanCore>await deploy("LoanCore", deployer, []);
            const OriginationController = await hre.ethers.getContractFactory("OriginationController");
            const originationController = await upgrades.deployProxy(OriginationController, [loanCore.address]);

            expect(await originationController.loanCore()).to.equal(loanCore.address);
        });
    });

    describe("Upgradeability", async () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("v1 functionality can be upgraded in v2", async () => {
            const { originationController, user: lender, other: borrower } = ctx;

            // THIS IS WHERE ORIGINATION CONTROLLER UPGRADES TO V2 / BECOMES MOCKORIGINATION CONTROLLER
            const MockOriginationController = await hre.ethers.getContractFactory("MockOriginationController");
            const mockOriginationController = <MockOriginationController>(
                await hre.upgrades.upgradeProxy(originationController.address, MockOriginationController)
            );
            // THE .version() FUNCTION RETURNS THAT THIS IS V2
            expect(await mockOriginationController.version()).to.equal("This is OriginationController V2!");
            // isApproved() IS CALLED AND RETURNS TRUE FOR FOR THE 2 ARGUMENTS NOT BEING EQUAL
            expect(await mockOriginationController.isApproved(await borrower.getAddress(), await lender.getAddress()))
                .to.be.true;
        });

        it("v1 functionality cannot be upgraded to v2 by non authorized user", async () => {
            const { originationController, user: lender, other } = ctx;
            const MockOriginationController = await hre.ethers.getContractFactory("MockOriginationController", other);

            await expect(
                hre.upgrades.upgradeProxy(originationController.address, MockOriginationController),
            ).to.be.revertedWith(`AccessControl: account ${other.address.toLowerCase()} is missing role ${ADMIN_ROLE}`);
        });
    });

    describe("initializeLoan", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("Reverts if msg.sender is not either lender or borrower", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    // some random guy
                    .connect(signers[3])
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("OC_CallerNotParticipant");
        });

        it("Reverts if wNFT not approved", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            // no approval of wNFT token
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
        });

        it("Reverts if principal not approved", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                1,
                "b",
            );

            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            // no approval of principal token
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
        });

        it("Reverts if principal below minimum allowable amount", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: BigNumber.from("9999"),
            });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                1,
                "b",
            );

            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            // no approval of principal token
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("OC_PrincipalTooLow");
        });

        it("Reverts if approving own loan", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    // sender is the borrower, signer is also the borrower
                    .connect(borrower)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Reverts if signer is not a participant", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            // signer is some random guy
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                signers[3],
                "2",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Reverts for an invalid nonce", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                3, // Use nonce 3
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    // Use nonce of 2, skipping nonce 1
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 2),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Reverts on an expired signature", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTermsExpired(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
            });

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                3, // Use nonce 3
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("OC_SignatureIsExpired");
        });

        it("Reverts if the nonce does not match the signature", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                2, // Use nonce 2
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Initializes a loan signed by the borrower", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        it("Initializes a loan signed by the lender", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "2",
                1,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        it("Initializes a loan with unbundled collateral", async () => {
            const { originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const tokenId = await mint721(mockERC721, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await mockERC721.connect(borrower).approve(originationController.address, tokenId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        it("does not allow a nonce to be re-used", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "2",
                1,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);

            // Successful loan - try to initialize loan again with same sig
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("LC_NonceUsed");
        });

        describe("initializeLoanWithCollateralPermit", () => {
            it("Reverts if the collateral does not support permit", async () => {
                const {
                    originationController,
                    vaultFactory,
                    user,
                    other,
                    mockERC20,
                    mockERC721,
                    lenderPromissoryNote,
                    borrowerPromissoryNote,
                    loanCore,
                } = ctx;

                const tokenId = await mint721(mockERC721, other);
                const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

                await mint(mockERC20, other, loanTerms.principal);

                // invalid signature because tokenId is something random here
                const permitData = {
                    owner: await user.getAddress(),
                    spender: originationController.address,
                    tokenId: 1234,
                    nonce: 0,
                    deadline: maxDeadline,
                };

                const collateralSig = await createPermitSignature(
                    vaultFactory.address,
                    await vaultFactory.name(),
                    permitData,
                    user,
                );

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    user,
                    "2",
                    1,
                    "b",
                );

                await expect(
                    originationController
                        .connect(user)
                        .initializeLoanWithCollateralPermit(
                            loanTerms,
                            lenderPromissoryNote.address,
                            borrowerPromissoryNote.address,
                            sig,
                            1,
                            collateralSig,
                            maxDeadline,
                        ),
                ).to.be.revertedWith("function selector was not recognized and there's no fallback function");
            });

            it("Reverts if vaultFactory.permit is invalid", async () => {
                const {
                    originationController,
                    vaultFactory,
                    user,
                    other,
                    mockERC20,
                    lenderPromissoryNote,
                    borrowerPromissoryNote,
                } = ctx;

                const bundleId = await initializeBundle(vaultFactory, user);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
                await mint(mockERC20, other, loanTerms.principal);

                // invalid signature because tokenId is something random here
                const permitData = {
                    owner: await user.getAddress(),
                    spender: originationController.address,
                    tokenId: 1234,
                    nonce: 0,
                    deadline: maxDeadline,
                };

                const collateralSig = await createPermitSignature(
                    vaultFactory.address,
                    await vaultFactory.name(),
                    permitData,
                    user,
                );

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    user,
                    "2",
                    1,
                    "b",
                );

                await expect(
                    originationController
                        .connect(user)
                        .initializeLoanWithCollateralPermit(
                            loanTerms,
                            lenderPromissoryNote.address,
                            borrowerPromissoryNote.address,
                            sig,
                            1,
                            collateralSig,
                            maxDeadline,
                        ),
                ).to.be.revertedWith("ERC721P_NotTokenOwner");
            });

            it("Initializes a loan with permit", async () => {
                const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
                await mint(mockERC20, lender, loanTerms.principal);

                const permitData = {
                    owner: await borrower.getAddress(),
                    spender: originationController.address,
                    tokenId: bundleId,
                    nonce: 0,
                    deadline: maxDeadline,
                };

                const collateralSig = await createPermitSignature(
                    vaultFactory.address,
                    await vaultFactory.name(),
                    permitData,
                    borrower,
                );

                const sig = await createLoanTermsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    borrower,
                    "2",
                    1,
                    "b",
                );

                await approve(mockERC20, lender, originationController.address, loanTerms.principal);
                await expect(
                    originationController
                        .connect(lender)
                        .initializeLoanWithCollateralPermit(
                            loanTerms,
                            await borrower.getAddress(),
                            await lender.getAddress(),
                            sig,
                            1,
                            collateralSig,
                            maxDeadline,
                        ),
                )
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
            });
        });
    });

    describe("initializeLoanWithItems", () => {
        let ctx: TestContext;
        let verifier: ArcadeItemsVerifier;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { user, originationController } = ctx;

            verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);
            await originationController.connect(user).setAllowedVerifier(verifier.address, true);
        });

        it("Reverts if the collateralAddress does not fit the vault factory interface", async () => {
            const { originationController, mockERC20, mockERC721, user: lender, other: borrower } = ctx;

            const tokenId = await mint721(mockERC721, borrower);

            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId });

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                lender,
                "2",
                "1",
                "l",
            );

            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoanWithItems(
                        loanTerms,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        predicates,
                    ),
            ).to.be.revertedWith("function selector was not recognized and there's no fallback function");
        });

        it("Reverts if the required predicates fail", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const tokenId = await mint721(mockERC721, borrower);
            // Do not transfer erc721 to bundle
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                lender,
                "2",
                "1",
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoanWithItems(
                        loanTerms,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        predicates,
                    ),
            ).to.be.revertedWith("OC_PredicateFailed");
        });

        it("Reverts if the required predicates array is empty", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const tokenId = await mint721(mockERC721, borrower);
            // Do not transfer erc721 to bundle
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });

            const predicates: ItemsPredicate[] = [];

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                lender,
                "2",
                "1",
                "l",
            );

            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoanWithItems(
                        loanTerms,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        predicates,
                    ),
            ).to.be.revertedWith("OC_PredicatesArrayEmpty");
        });

        it("Reverts for an invalid nonce", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                borrower,
                "2",
                "2", // Use nonce 2
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController.connect(lender).initializeLoanWithItems(
                    loanTerms,
                    await borrower.getAddress(),
                    await lender.getAddress(),
                    sig,
                    // Use nonce a nonce value that does not match the nonce in sig
                    2,
                    predicates,
                ),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Reverts if the nonce does not match the signature", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                borrower,
                "2",
                "2", // Use nonce 2,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoanWithItems(
                        loanTerms,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        predicates,
                    ),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("Reverts if the verifier contract is not approved", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;

            // Remove verifier approval
            await originationController.connect(lender).setAllowedVerifier(verifier.address, false);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                borrower,
                "2",
                "1",
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoanWithItems(
                        loanTerms,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        predicates,
                    ),
            ).to.be.revertedWith("OC_InvalidVerifier");
        });

        it("Initalizes a loan signed by the borrower", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                borrower,
                "2",
                "1",
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoanWithItems(
                        loanTerms,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        predicates,
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        it("Initalizes a loan signed by the lender", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                lender,
                "2",
                "1",
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoanWithItems(
                        loanTerms,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        predicates,
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        it("does not allow a nonce to be re-used", async () => {
            const { originationController, mockERC20, mockERC721, vaultFactory, user: lender, other: borrower } = ctx;

            // Create two bundles, fund both with same items
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const bundleId2 = await initializeBundle(vaultFactory, borrower);
            const bundleAddress2 = await vaultFactory.instanceAt(bundleId2);

            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);
            const tokenId2 = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress2, tokenId2);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const loanTerms2 = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId2 });

            // Should be valid for both terms/bundles
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: 0,
                    amount: 1,
                    anyIdAllowed: true
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                lender,
                "2",
                "1",
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoanWithItems(
                        loanTerms,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        predicates,
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);

            // Try a second time, with another valid bundle
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId2);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoanWithItems(
                        loanTerms2,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        predicates,
                    ),
            ).to.be.revertedWith("LC_NonceUsed");
        });
        it("Initializes a loan with permit and items", async () => {
            const {
                originationController,
                mockERC20,
                mockERC721,
                vaultFactory,
                user: lender,
                other: borrower,
                lenderPromissoryNote,
                borrowerPromissoryNote,
            } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId,
                    amount: 1,
                    anyIdAllowed: false
                },
            ];

            const predicates: ItemsPredicate[] = [
                {
                    verifier: verifier.address,
                    data: encodeSignatureItems(signatureItems),
                },
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const permitData = {
                owner: await borrower.getAddress(),
                spender: originationController.address,
                tokenId: bundleAddress,
                nonce: 0,
                deadline: maxDeadline,
            };

            const collateralSig = await createPermitSignature(
                vaultFactory.address,
                await vaultFactory.name(),
                permitData,
                borrower,
            );

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                encodePredicates(predicates),
                borrower,
                "2",
                "1",
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoanWithCollateralPermitAndItems(
                        loanTerms,
                        await borrower.getAddress(),
                        await lender.getAddress(),
                        sig,
                        1,
                        collateralSig,
                        maxDeadline,
                        predicates,
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        describe("initializeLoanWithCollateralPermitAndItems", () => {
            it("Reverts if vaultFactory.permit is invalid", async () => {
                const {
                    originationController,
                    vaultFactory,
                    user: lender,
                    other: borrower,
                    mockERC20,
                    mockERC721,
                    lenderPromissoryNote,
                    borrowerPromissoryNote,
                } = ctx;

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const bundleAddress = await vaultFactory.instanceAt(bundleId);
                const tokenId = await mint721(mockERC721, borrower);
                await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
                const signatureItems: SignatureItem[] = [
                    {
                        cType: 0,
                        asset: mockERC721.address,
                        tokenId,
                        amount: 1,
                        anyIdAllowed: false
                    },
                ];

                const predicates: ItemsPredicate[] = [
                    {
                        verifier: verifier.address,
                        data: encodeSignatureItems(signatureItems),
                    },
                ];

                await mint(mockERC20, lender, loanTerms.principal);

                // invalid signature because tokenId is something random here
                const permitData = {
                    owner: await lender.getAddress(),
                    spender: originationController.address,
                    tokenId: 1234,
                    nonce: 0,
                    deadline: maxDeadline,
                };

                const collateralSig = await createPermitSignature(
                    vaultFactory.address,
                    await vaultFactory.name(),
                    permitData,
                    lender,
                );

                const sig = await createLoanItemsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    encodePredicates(predicates),
                    lender,
                    "2",
                    "1",
                    "b",
                );

                await expect(
                    originationController
                        .connect(lender)
                        .initializeLoanWithCollateralPermitAndItems(
                            loanTerms,
                            lenderPromissoryNote.address,
                            borrowerPromissoryNote.address,
                            sig,
                            1,
                            collateralSig,
                            maxDeadline,
                            predicates,
                        ),
                ).to.be.revertedWith("ERC721P_NotTokenOwner");
            });

            it("Trigger ERC721Permit not token owner", async () => {
                const {
                    originationController,
                    vaultFactory,
                    user: lender,
                    other: borrower,
                    mockERC20,
                    mockERC721,
                    lenderPromissoryNote,
                    borrowerPromissoryNote,
                } = ctx;

                const bundleId = await initializeBundle(vaultFactory, borrower);
                const bundleAddress = await vaultFactory.instanceAt(bundleId);
                const tokenId = await mint721(mockERC721, borrower);
                await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

                const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
                const signatureItems: SignatureItem[] = [
                    {
                        cType: 0,
                        asset: mockERC721.address,
                        tokenId,
                        amount: 1,
                        anyIdAllowed: false
                    },
                ];

                const predicates: ItemsPredicate[] = [
                    {
                        verifier: verifier.address,
                        data: encodeSignatureItems(signatureItems),
                    },
                ];

                await mint(mockERC20, lender, loanTerms.principal);

                const permitData = {
                    owner: await borrower.getAddress(),
                    spender: originationController.address,
                    tokenId: bundleId,
                    nonce: 0,
                    deadline: maxDeadline,
                };

                const collateralSig = await createPermitSignature(
                    vaultFactory.address,
                    await vaultFactory.name(),
                    permitData,
                    lender,
                );

                const sig = await createLoanItemsSignature(
                    originationController.address,
                    "OriginationController",
                    loanTerms,
                    encodePredicates(predicates),
                    lender,
                    "2",
                    "1",
                    "b",
                );

                await expect(
                    originationController
                        .connect(borrower)
                        .initializeLoanWithCollateralPermitAndItems(
                            loanTerms,
                            lenderPromissoryNote.address,
                            borrowerPromissoryNote.address,
                            sig,
                            1,
                            collateralSig,
                            maxDeadline,
                            predicates,
                        ),
                ).to.be.revertedWith("ERC721P_NotTokenOwner");
            });
        });
    });

    describe("verification whitelist", () => {
        let ctx: TestContext;
        let verifier: ArcadeItemsVerifier;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", ctx.user, []);
        });

        it("does not allow a non-admin to update the whitelist", async () => {
            const { other, originationController } = ctx;

            await expect(
                originationController.connect(other).setAllowedVerifier(verifier.address, true),
            ).to.be.revertedWith(`AccessControl: account ${other.address.toLowerCase()} is missing role ${ADMIN_ROLE}`);
        });

        it("Try to set 0x0000 as address, should revert.", async () => {
            const { user, originationController } = ctx;

            await expect(
                originationController
                    .connect(user)
                    .setAllowedVerifier("0x0000000000000000000000000000000000000000", true),
            ).to.be.revertedWith("OC_ZeroAddress");
        });

        it("allows the contract owner to update the whitelist", async () => {
            const { user, originationController } = ctx;

            await expect(originationController.connect(user).setAllowedVerifier(verifier.address, true))
                .to.emit(originationController, "SetAllowedVerifier")
                .withArgs(verifier.address, true);

            expect(await originationController.isAllowedVerifier(verifier.address)).to.be.true;
        });

        it("does not allow a non-admin to perform a batch update", async () => {
            const { user, other, originationController } = ctx;

            const verifier2 = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await expect(
                originationController
                    .connect(other)
                    .setAllowedVerifierBatch([verifier.address, verifier2.address], [true, true]),
            ).to.be.revertedWith(`AccessControl: account ${other.address.toLowerCase()} is missing role ${ADMIN_ROLE}`);
        });

        it("reverts if a batch update's arguments have mismatched length", async () => {
            const { user, originationController } = ctx;

            const verifier2 = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await expect(
                originationController
                    .connect(user)
                    .setAllowedVerifierBatch([verifier.address, verifier2.address], [true]),
            ).to.be.revertedWith("OC_BatchLengthMismatch");
        });

        it("allows the contract owner to perform a batch update", async () => {
            const { user, originationController } = ctx;

            await originationController.connect(user).setAllowedVerifier(verifier.address, true);
            expect(await originationController.isAllowedVerifier(verifier.address)).to.be.true;

            // Deploy a new verifier, disable the first one
            const verifier2 = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await expect(
                originationController
                    .connect(user)
                    .setAllowedVerifierBatch([verifier.address, verifier2.address], [false, true]),
            )
                .to.emit(originationController, "SetAllowedVerifier")
                .withArgs(verifier.address, false)
                .to.emit(originationController, "SetAllowedVerifier")
                .withArgs(verifier2.address, true);

            expect(await originationController.isAllowedVerifier(verifier.address)).to.be.false;
            expect(await originationController.isAllowedVerifier(verifier2.address)).to.be.true;
        });
    });

    describe("approvals", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("reverts if trying to approve oneself", async () => {
            const { originationController, other: borrower } = ctx;

            await expect(originationController.connect(borrower).approve(borrower.address, true)).to.be.revertedWith(
                "OC_SelfApprove",
            );
        });

        it("allows the borrower to approve another signer", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;
            const [newSigner] = signers;

            await expect(originationController.connect(borrower).approve(newSigner.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(borrower.address, newSigner.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                newSigner, // Now signed by a third party
                "2",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        it("allows the lender to approve another signer", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;
            const [newSigner] = signers;

            await expect(originationController.connect(lender).approve(newSigner.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(lender.address, newSigner.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                newSigner, // Now signed by a third party
                "2",
                1,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        it("allows the borrower to approve another originator", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;
            const [newOriginator] = signers;

            await expect(originationController.connect(borrower).approve(newOriginator.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(borrower.address, newOriginator.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "2",
                1,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(newOriginator)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        it("allows the lender to approve another originator", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower, signers } = ctx;
            const [newOriginator] = signers;

            await expect(originationController.connect(lender).approve(newOriginator.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(lender.address, newOriginator.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(newOriginator)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal);
        });

        it("honors an ERC-1271 approval", async () => {
            // Deploy an ERC-1271 to act as the lender
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;
            const lenderContract = <ERC1271LenderMock>await deploy("ERC1271LenderMock", lender, []);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await mockERC20.connect(lender).transfer(lenderContract.address, loanTerms.principal);
            await lenderContract.approve(mockERC20.address, originationController.address);

            // No approval for origination - OC will check ERC-1271

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "2",
                1,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(loanTerms, await borrower.getAddress(), lenderContract.address, sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lenderContract.address, originationController.address, loanTerms.principal);
        });

        it("does not allow unilateral borrower origination even if the lender approves", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            await expect(originationController.connect(lender).approve(borrower.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(lender.address, borrower.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "2",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("does not allow unilateral lender origination even if the borrower approves", async () => {
            const { originationController, mockERC20, vaultFactory, user: lender, other: borrower } = ctx;

            await expect(originationController.connect(borrower).approve(lender.address, true))
                .to.emit(originationController, "Approval")
                .withArgs(borrower.address, lender.address, true);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "2",
                1,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("OC_ApprovedOwnLoan");
        });
    });
});
