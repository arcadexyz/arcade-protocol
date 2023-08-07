import { expect } from "chai";
import { ethers, waffle } from "hardhat";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber } from "ethers";

import {
    VaultFactory,
    CallWhitelist,
    AssetVault,
    AssetVault__factory,
    FeeController,
    OriginationController,
    PromissoryNote,
    RepaymentController,
    LoanCore,
    MockERC20,
    ArcadeItemsVerifier,
    MockERC721,
    BaseURIDescriptor
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { deploy } from "./utils/contracts";
import { approve, mint } from "./utils/erc20";
import { mint as mint721 } from "./utils/erc721";
import { LoanTerms, LoanData, ItemsPredicate } from "./utils/types";
import { createLoanItemsSignature, createLoanTermsSignature } from "./utils/eip712";
import { encodeItemCheck } from "./utils/loans";

import {
    ADMIN_ROLE,
    ORIGINATOR_ROLE,
    FEE_CLAIMER_ROLE,
    REPAYER_ROLE,
    AFFILIATE_MANAGER_ROLE,
    BASE_URI,
    RESOURCE_MANAGER_ROLE,
    MINT_BURN_ROLE,
    WHITELIST_MANAGER_ROLE,
    MIN_LOAN_PRINCIPAL
} from "./utils/constants";

interface TestContext {
    loanCore: LoanCore;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    borrowerNote: PromissoryNote;
    lenderNote: PromissoryNote;
    vaultFactory: VaultFactory;
    whitelist: CallWhitelist;
    feeController: FeeController;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    descriptor: BaseURIDescriptor;
    borrower: SignerWithAddress;
    lender: SignerWithAddress;
    admin: SignerWithAddress;
    currentTimestamp: number;
    blockchainTime: BlockchainTime;
}

interface LoanDef {
    loanId: string;
    bundleId: string;
    loanTerms: LoanTerms;
    loanData: LoanData;
}

const blockchainTime = new BlockchainTime();

/**
 * Sets up a test context, deploying new contracts and returning them for use in a test
 */
const fixture = async (): Promise<TestContext> => {
    const blockchainTime = new BlockchainTime();
    const currentTimestamp = await blockchainTime.secondsFromNow(0);

    const signers: SignerWithAddress[] = await ethers.getSigners();
    const [borrower, lender, admin] = signers;

    const whitelist = <CallWhitelist>await deploy("CallWhitelist", admin, []);
    const vaultTemplate = <AssetVault>await deploy("AssetVault", admin, []);
    const feeController = <FeeController>await deploy("FeeController", admin, []);
    const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", admin, [BASE_URI])
    const vaultFactory = <VaultFactory>await deploy("VaultFactory", admin, [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address]);

    const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN", descriptor.address]);
    const lenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN", descriptor.address]);

    const loanCore = <LoanCore>await deploy("LoanCore", admin, [borrowerNote.address, lenderNote.address]);

    await loanCore.grantRole(FEE_CLAIMER_ROLE, admin.address);

    // Grant correct permissions for promissory note
    for (const note of [borrowerNote, lenderNote]) {
        await note.connect(admin).initialize(loanCore.address);
    }

    const mockERC20 = <MockERC20>await deploy("MockERC20", admin, ["Mock ERC20", "MOCK"]);
    const mockERC721 = <MockERC721>await deploy("MockERC721", admin, ["Mock ERC721", "MOCK"]);

    const repaymentController = <RepaymentController>await deploy("RepaymentController", admin, [loanCore.address, feeController.address]);
    await repaymentController.deployed();
    const updateRepaymentControllerPermissions = await loanCore.grantRole(
        REPAYER_ROLE,
        repaymentController.address,
    );
    await updateRepaymentControllerPermissions.wait();

    const originationController = <OriginationController>await deploy(
        "OriginationController", admin, [loanCore.address, feeController.address]
    )
    await originationController.deployed();

    // admin whitelists MockERC20 on OriginationController
    await originationController.setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    // verify the currency is whitelisted
    const isWhitelisted = await originationController.allowedCurrencies(mockERC20.address);
    expect(isWhitelisted.isAllowed).to.be.true;
    expect(isWhitelisted.minPrincipal).to.eq(MIN_LOAN_PRINCIPAL);

    // admin whitelists MockERC721 and vaultFactory on OriginationController
    await originationController.setAllowedCollateralAddresses(
        [mockERC721.address, vaultFactory.address],
        [true, true]
    );
    // verify the collateral is whitelisted
    const isCollateralWhitelisted = await originationController.allowedCollateral(mockERC721.address);
    expect(isCollateralWhitelisted).to.be.true;
    const isVaultFactoryWhitelisted = await originationController.allowedCollateral(vaultFactory.address);
    expect(isVaultFactoryWhitelisted).to.be.true;

    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    return {
        loanCore,
        borrowerNote,
        lenderNote,
        vaultFactory,
        whitelist,
        feeController,
        repaymentController,
        originationController,
        mockERC20,
        mockERC721,
        descriptor,
        borrower,
        lender,
        admin,
        currentTimestamp,
        blockchainTime,
    };
};

/**
 * Create a LoanTerms object using the given parameters, or defaults
 */
const createLoanTerms = (
    payableCurrency: string,
    collateralAddress: string,
    {
        durationSecs = BigNumber.from(3600000),
        principal = ethers.utils.parseEther("100"),
        proratedInterestRate = ethers.utils.parseEther("1000"),
        collateralId = 1,
        deadline = 1754884800,
        affiliateCode = ethers.constants.HashZero,
    }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        proratedInterestRate,
        collateralAddress,
        collateralId,
        payableCurrency,
        deadline,
        affiliateCode
    };
};

const createWnft = async (vaultFactory: VaultFactory, user: SignerWithAddress) => {
    const tx = await vaultFactory.initializeBundle(user.address);
    const receipt = await tx.wait();
    if (receipt && receipt.events && receipt.events.length === 3 && receipt.events[2].args) {
        return receipt.events[2].args.vault;
    } else {
        throw new Error("Unable to initialize bundle");
    }
};

const initializeLoan = async (
    context: TestContext,
    nonce: number,
    terms?: Partial<LoanTerms>,
    affiliateCode = ethers.constants.HashZero
): Promise<LoanDef> => {
    const { originationController, feeController, mockERC20, vaultFactory, loanCore, lender, borrower } = context;
    const bundleId = terms?.collateralId ?? (await createWnft(vaultFactory, borrower));
    const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId, affiliateCode });
    if (terms) Object.assign(loanTerms, terms);

    const lenderFeeBps = await feeController.getLendingFee(await feeController.FL_02());
    const lenderFee = loanTerms.principal.mul(lenderFeeBps).div(10_000);
    const lenderWillSend = loanTerms.principal.add(lenderFee);

    await mint(mockERC20, lender, lenderWillSend);

    const sig = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        loanTerms,
        borrower,
        "3",
        nonce,
        "b",
    );

    await approve(mockERC20, lender, loanCore.address, lenderWillSend);
    await vaultFactory.connect(borrower).approve(loanCore.address, bundleId);

    const tx = await originationController
        .connect(lender)
        .initializeLoan(loanTerms, borrower.address, lender.address, sig, nonce);
    const receipt = await tx.wait();

    let loanId;

    if (receipt && receipt.events) {
        const loanCreatedLog = new ethers.utils.Interface([
            "event LoanStarted(uint256 loanId, address lender, address borrower)",
        ]);
        const log = loanCreatedLog.parseLog(receipt.events[receipt.events.length - 1]);
        loanId = log.args.loanId;
    } else {
        throw new Error("Unable to initialize loan");
    }
    return {
        loanId,
        bundleId,
        loanTerms,
        loanData: await loanCore.getLoan(loanId),
    };
};

describe("Integration", () => {
    describe("Deployment Permissions", () => {
        it("verify deployed contract permissions", async () => {
            const {
                loanCore,
                borrowerNote,
                lenderNote,
                vaultFactory,
                descriptor,
                whitelist,
                feeController,
                repaymentController,
                originationController,
                admin
            } = await loadFixture(fixture);

            // LoanCore roles
            expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, admin.address)).to.be.true;
            expect(await loanCore.hasRole(ORIGINATOR_ROLE, originationController.address)).to.be.true;
            expect(await loanCore.hasRole(REPAYER_ROLE, repaymentController.address)).to.be.true;
            // CallWhitelist owner
            expect(await whitelist.owner()).to.equal(admin.address);
            // FeeController owner
            expect(await feeController.owner()).to.equal(admin.address);
            // BaseURIDescriptor owner
            expect(await descriptor.owner()).to.equal(admin.address);
            // VaultFactory roles
            expect(await vaultFactory.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
            expect(await vaultFactory.hasRole(FEE_CLAIMER_ROLE, admin.address)).to.be.true;
            // PromissoryNotes roles
            expect(await borrowerNote.hasRole(ADMIN_ROLE, admin.address)).to.be.false;
            expect(await borrowerNote.hasRole(MINT_BURN_ROLE, loanCore.address)).to.be.true;
            expect(await borrowerNote.hasRole(RESOURCE_MANAGER_ROLE, admin.address)).to.be.true;
            expect(await lenderNote.hasRole(ADMIN_ROLE, admin.address)).to.be.false;
            expect(await lenderNote.hasRole(MINT_BURN_ROLE, loanCore.address)).to.be.true;
            expect(await lenderNote.hasRole(RESOURCE_MANAGER_ROLE, admin.address)).to.be.true;
            // OriginationController roles
            expect(await originationController.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
            expect(await originationController.hasRole(WHITELIST_MANAGER_ROLE, admin.address)).to.be.true;
        });
    });

    describe("Originate Loan", function () {
        it("should successfully create a loan", async () => {
            const { originationController, mockERC20, loanCore, vaultFactory, lender, borrower } = await loadFixture(
                fixture,
            );

            const bundleId = await createWnft(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "3",
                1,
                "b",
            );

            await approve(mockERC20, lender, loanCore.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(loanCore.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrower.address, lender.address, sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, loanCore.address, loanTerms.principal)
                .to.emit(loanCore, "LoanStarted");
        });

        it("should fail to start loan if wNFT has withdraws enabled", async () => {
            const { loanCore, originationController, mockERC20, vaultFactory, lender, borrower } = await loadFixture(fixture);

            const bundleId = await createWnft(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "3",
                1,
                "b",
            );

            await approve(mockERC20, lender, loanCore.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(loanCore.address, bundleId);
            // simulate someone trying to withdraw just before initializing the loan
            await AssetVault__factory.connect(bundleId, borrower).connect(borrower).enableWithdraw();
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrower.address, lender.address, sig, 1),
            ).to.be.revertedWith("VF_NoTransferWithdrawEnabled");
        });

        it("should fail to create a loan with nonexistent collateral", async () => {
            const { loanCore, originationController, mockERC20, lender, borrower, vaultFactory } = await loadFixture(fixture);

            const mockOpenVault = await deploy("MockOpenVault", borrower, []);
            const bundleId = mockOpenVault.address;
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "3",
                1,
                "b",
            );

            await approve(mockERC20, lender, loanCore.address, loanTerms.principal);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrower.address, lender.address, sig, 1),
            ).to.be.revertedWith("ERC721: operator query for nonexistent token");
        });

        it("should fail to create a loan with passed due date", async () => {
            const { loanCore, originationController, mockERC20, vaultFactory, lender, borrower } = await loadFixture(fixture);
            const bundleId = await createWnft(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                durationSecs: BigNumber.from(0),
            });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "3",
                1,
                "b",
            );

            await approve(mockERC20, lender, loanCore.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(loanCore.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, borrower.address, lender.address, sig, 1),
            ).to.be.revertedWith("OC_LoanDuration");
        });
    });

    describe("Repay Loan", function () {
        it("should successfully repay loan", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender } = context;
            const { loanId, loanTerms, bundleId } = await initializeLoan(context, 1);

            const grossInterest = loanTerms.principal.mul(loanTerms.proratedInterestRate).div(ethers.utils.parseEther("10000"));
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20
                .connect(borrower)
                .approve(loanCore.address, loanTerms.principal.add(loanTerms.proratedInterestRate));

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);
            const preLenderBalance = await mockERC20.balanceOf(lender.address);

            await expect(repaymentController.connect(borrower).repay(loanId))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId);

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);
            const postLenderBalance = await mockERC20.balanceOf(lender.address);
            expect(postLenderBalance.sub(preLenderBalance)).to.equal(ethers.utils.parseEther("110"));
        });

        it("should allow the collateral to be reused after repay", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, loanCore, borrower } = context;
            const { loanId, loanTerms, bundleId } = await initializeLoan(context, 1);

            const grossInterest = loanTerms.principal.mul(loanTerms.proratedInterestRate).div(ethers.utils.parseEther("10000"));
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);

            await mockERC20
                .connect(borrower)
                .approve(loanCore.address, loanTerms.principal.add(loanTerms.proratedInterestRate));

            await expect(repaymentController.connect(borrower).repay(loanId))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId);

            // create a new loan with the same bundleId
            const { loanId: newLoanId } = await initializeLoan(context, 2, {
                collateralId: bundleId,
            });

            // initializeLoan asserts loan created successfully based on logs, so test that new loan is a new instance
            expect(newLoanId !== loanId);
        });

        it("fails if payable currency is not approved", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower } = context;
            const { loanTerms, loanId } = await initializeLoan(context, 1);

            const grossInterest = loanTerms.principal.mul(loanTerms.proratedInterestRate).div(ethers.utils.parseEther("10000"));
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);

            await expect(repaymentController.connect(borrower).repay(loanId)).to.be.revertedWith(
                "ERC20: transfer amount exceeds allowance",
            );
        });

        it("fails with invalid note ID", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower } = context;
            const { loanTerms } = await initializeLoan(context, 1);

            const grossInterest = loanTerms.principal.mul(loanTerms.proratedInterestRate).div(ethers.utils.parseEther("10000"));
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20
                .connect(borrower)
                .approve(repaymentController.address, loanTerms.principal.add(loanTerms.proratedInterestRate));

            await expect(repaymentController.connect(borrower).repay(1234)).to.be.revertedWith("RC_CannotDereference");
        });
    });

    describe("Claim loan", function () {
        const initializeLoan = async (
            context: TestContext,
            nonce: number,
            terms?: Partial<LoanTerms>,
        ): Promise<LoanDef> => {
            const { originationController, mockERC20, vaultFactory, loanCore, lender, borrower } = context;
            const durationSecs = BigNumber.from(3600);
            const bundleId = terms?.collateralId ?? (await createWnft(vaultFactory, borrower));
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                durationSecs,
            });
            if (terms) Object.assign(loanTerms, terms);
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "3",
                nonce,
                "b",
            );

            await approve(mockERC20, lender, loanCore.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(loanCore.address, bundleId);
            const tx = await originationController
                .connect(lender)
                .initializeLoan(loanTerms, borrower.address, lender.address, sig, nonce);
            const receipt = await tx.wait();

            let loanId;
            if (receipt && receipt.events) {
                const LoanCreatedLog = new ethers.utils.Interface([
                    "event LoanStarted(uint256 loanId, address lender, address borrower)",
                ]);
                const log = LoanCreatedLog.parseLog(receipt.events[receipt.events.length - 1]);
                loanId = log.args.loanId;
            } else {
                throw new Error("Unable to initialize loan");
            }

            return {
                loanId,
                bundleId,
                loanTerms,
                loanData: await loanCore.getLoan(loanId),
            };
        };

        it("should successfully claim loan", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, vaultFactory, loanCore, lender } = context;
            const { loanId, bundleId } = await initializeLoan(context, 1);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);
            await blockchainTime.increaseTime(3600); // increase past loan duration
            await blockchainTime.increaseTime(600); // increase past grace period

            await expect(repaymentController.connect(lender).claim(loanId))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(lender.address);
        });

        it("should allow the collateral to be reused after claim", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, vaultFactory, loanCore, lender, borrower } = context;
            const { loanId, bundleId } = await initializeLoan(context, 1);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);
            await blockchainTime.increaseTime(3600); // increase past loan duration
            await blockchainTime.increaseTime(600); // increase past grace period

            await expect(repaymentController.connect(lender).claim(loanId))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            // create a new loan with the same bundleId
            // transfer the collateral back to the original borrower
            await vaultFactory
                .connect(lender)
                .transferFrom(lender.address, borrower.address, bundleId);
            const { loanId: newLoanId } = await initializeLoan(context, 20, {
                collateralId: bundleId,
            });
            // initializeLoan asserts loan created successfully based on logs, so test that new loan is a new instance
            expect(newLoanId !== loanId);
        });

        it("fails if not past durationSecs", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, lender } = context;
            const { loanId } = await initializeLoan(context, 1);

            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_NotExpired");
        });

        it("fails for invalid noteId", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, lender } = context;

            await blockchainTime.increaseTime(3600); // increase past loan duration
            await blockchainTime.increaseTime(600); // increase past grace period

            await expect(repaymentController.connect(lender).claim(1234)).to.be.revertedWith(
                "RC_CannotDereference"
            );
        });

        it("fails if not called by lender", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, borrower } = context;
            const { loanId } = await initializeLoan(context, 1);

            await blockchainTime.increaseTime(3600); // increase past loan duration
            await blockchainTime.increaseTime(600); // increase past grace period

            await expect(repaymentController.connect(borrower).claim(loanId)).to.be.revertedWith("RC_OnlyLender");
        });
    });

    describe("End-to-end", () => {
        it("full loan cycle, no fees", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender } = context;

            const { loanId, loanTerms, bundleId } = await initializeLoan(context, 1, undefined);

            const grossInterest = loanTerms.principal.mul(loanTerms.proratedInterestRate).div(ethers.utils.parseEther("10000"));
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20
                .connect(borrower)
                .approve(loanCore.address, repayAmount);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            await expect(repaymentController.connect(borrower).repay(loanId))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(mockERC20, "Transfer")
                .withArgs(borrower.address, loanCore.address, repayAmount)
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, ethers.utils.parseEther("110"));

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);

            // No fees accrued
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(0);
        });

        it("full loan cycle, with realistic fees and registered affiliate", async () => {
            const context = await loadFixture(fixture);
            const { feeController, repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, admin } = context;

            // Set a 50 bps lender fee on origination,
            // and a 10% fee on interest. Total fees earned should be
            // 0.5 (on principal) + 1 (on interest) = 1.5 ETH
            await feeController.setLendingFee(await feeController.FL_02(), 50);
            await feeController.setLendingFee(await feeController.FL_06(), 10_00);

            // Set affiliate share to 10% of fees for borrower
            await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, admin.address);
            const code = ethers.utils.id("BORROWER_A");
            await loanCore.connect(admin).setAffiliateSplits([code], [{ affiliate: borrower.address, splitBps: 10_00 }]);
            const { loanId, loanTerms, bundleId } = await initializeLoan(context, 1, undefined, code);

            const grossInterest = loanTerms.principal.mul(loanTerms.proratedInterestRate).div(ethers.utils.parseEther("10000"));
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20
                .connect(borrower)
                .approve(loanCore.address, repayAmount);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            await expect(repaymentController.connect(borrower).repay(loanId))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(mockERC20, "Transfer")
                .withArgs(borrower.address, loanCore.address, repayAmount)
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, ethers.utils.parseEther("109"));

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);

            // Withdraw fees for both protocol and affiliate
            await expect(
                loanCore.connect(borrower).withdraw(mockERC20.address, ethers.utils.parseEther("0.15"), borrower.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, ethers.utils.parseEther("0.15"));

            // Protocol admin gets 1.35 ETH - 1.5 total fees minus 10% affiliate share on fees
            await expect(
                loanCore.connect(admin).withdrawProtocolFees(mockERC20.address, admin.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, admin.address, admin.address, ethers.utils.parseEther("1.35"));

            // All fees withdrawn
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(0);
        });

        it("full loan cycle, with realistic fees and registered affiliate, two-step repay", async () => {
            const context = await loadFixture(fixture);
            const { feeController, repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, admin, lenderNote } = context;

            // Set a 50 bps lender fee on origination,
            // and a 10% fee on interest, plus 5% on redemption.
            // Total fees earned should be
            // 0.5 (on principal) + 1 (on interest) + 5.45 (on redemption) = 6.95 ETH
            await feeController.setLendingFee(await feeController.FL_02(), 50);
            await feeController.setLendingFee(await feeController.FL_06(), 10_00);
            await feeController.setLendingFee(await feeController.FL_08(), 5_00);

            // Set affiliate share to 10% of fees for borrower
            await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, admin.address);
            const code = ethers.utils.id("BORROWER_A");
            await loanCore.connect(admin).setAffiliateSplits([code], [{ affiliate: borrower.address, splitBps: 10_00 }]);
            const { loanId, loanTerms, bundleId } = await initializeLoan(context, 1, undefined, code);

            const grossInterest = loanTerms.principal.mul(loanTerms.proratedInterestRate).div(ethers.utils.parseEther("10000"));
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20
                .connect(borrower)
                .approve(loanCore.address, repayAmount);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            await expect(repaymentController.connect(borrower).forceRepay(loanId))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "ForceRepay")
                .withArgs(loanId)
                .to.emit(mockERC20, "Transfer")
                .withArgs(borrower.address, loanCore.address, repayAmount);

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);
            expect(await lenderNote.ownerOf(loanId)).to.equal(lender.address);

            // redeem the note to complete the repay flow
            await expect(repaymentController.connect(lender).redeemNote(loanId, lender.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, lender.address, loanId, ethers.utils.parseEther("103.55"))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, ethers.utils.parseEther("103.55"));

            // Withdraw fees for both protocol and affiliate
            await expect(
                loanCore.connect(borrower).withdraw(mockERC20.address, ethers.utils.parseEther("0.695"), borrower.address)
            ).to.emit(loanCore, "FeesWithdrawn")
               .withArgs(mockERC20.address, borrower.address, borrower.address, ethers.utils.parseEther("0.695"));

            // Protocol admin gets 6.255 ETH - 6.95 total fees minus 10% affiliate share on fees
            await expect(
                loanCore.connect(admin).withdrawProtocolFees(mockERC20.address, admin.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, admin.address, admin.address, ethers.utils.parseEther("6.255"));

            // All fees withdrawn
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(0);
        });

        it("full loan cycle, with realistic fees and registered affiliate, on an unvaulted asset with a rollover", async () => {
            const context = await loadFixture(fixture);
            const { feeController, repaymentController, originationController, mockERC20, mockERC721, loanCore, borrower, lender, admin } = context;

            const uvVerifier = <ArcadeItemsVerifier>await deploy("UnvaultedItemsVerifier", admin, []);
            await originationController.setAllowedVerifiers([uvVerifier.address], [true]);
            await originationController.setAllowedCollateralAddresses([mockERC721.address], [true]);

            // Set a 50 bps lender fee on origination, a 3% borrower rollover
            // fee, and a 10% fee on interest. Total fees earned should be
            // 0.5 (on principal) + 1 (on interest) + 3 (on rollover) = 4.5 ETH
            await feeController.setLendingFee(await feeController.FL_02(), 50);
            await feeController.setLendingFee(await feeController.FL_06(), 10_00);
            await feeController.setLendingFee(await feeController.FL_03(), 3_00);

            // Set affiliate share to 10% of fees for borrower
            await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, admin.address);
            const code = ethers.utils.id("BORROWER_A");
            await loanCore.connect(admin).setAffiliateSplits([code], [{ affiliate: borrower.address, splitBps: 10_00 }]);

            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).approve(loanCore.address, tokenId);
            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, { collateralId: tokenId, affiliateCode: code });

            const lenderFeeBps = await feeController.getLendingFee(await feeController.FL_02());
            const lenderFee = loanTerms.principal.mul(lenderFeeBps).div(10_000);
            const lenderWillSend = loanTerms.principal.add(lenderFee);

            const predicates: ItemsPredicate[] = [
                {
                    verifier: uvVerifier.address,
                    data: encodeItemCheck(mockERC721.address, 0, true),
                }
            ];

            await mint(mockERC20, lender, lenderWillSend);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                "3",
                "1",
                "b",
            );

            await approve(mockERC20, lender, loanCore.address, lenderWillSend);

            const tx = await originationController
                .connect(lender)
                .initializeLoanWithItems(
                    loanTerms,
                    borrower.address,
                    lender.address,
                    sig,
                    1,
                    predicates
                );

            const receipt = await tx.wait();

            let loanId;

            if (receipt && receipt.events) {
                const loanCreatedLog = new ethers.utils.Interface([
                    "event LoanStarted(uint256 loanId, address lender, address borrower)",
                ]);
                const log = loanCreatedLog.parseLog(receipt.events[receipt.events.length - 1]);
                loanId = log.args.loanId;
            } else {
                throw new Error("Unable to initialize loan");
            }

            const rolloverPredicates: ItemsPredicate[] = [
                {
                    verifier: uvVerifier.address,
                    data: encodeItemCheck(mockERC721.address, tokenId, false),
                }
            ];

            const rolloverSig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                rolloverPredicates,
                lender,
                "3",
                "2",
                "l",
            );

            const grossInterest = loanTerms.principal.mul(loanTerms.proratedInterestRate).div(ethers.utils.parseEther("10000"));
            const rolloverFee = loanTerms.principal.div(100).mul(3);
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, grossInterest.add(rolloverFee));
            await approve(mockERC20, borrower, originationController.address, grossInterest.add(rolloverFee));

            const newLoanId = Number(loanId) + 1;

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            await expect(originationController.connect(borrower).rolloverLoanWithItems(
                loanId,
                loanTerms,
                lender.address,
                rolloverSig,
                2,
                rolloverPredicates
            ))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, lender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays 10 ETH interest + 3 ETH rollover fee
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("13"));
            // Lender collects interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("10"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates rollover fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("3"));

            // pre-repaid state
            expect(await mockERC721.ownerOf(tokenId)).to.equal(loanCore.address);

            await mint(mockERC20, borrower, repayAmount);
            await approve(mockERC20, borrower, loanCore.address, repayAmount);

            // Repay - loan was for same terms, so will earn
            await expect(repaymentController.connect(borrower).repay(newLoanId))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(newLoanId)
                .to.emit(mockERC20, "Transfer")
                .withArgs(borrower.address, loanCore.address, repayAmount)
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, ethers.utils.parseEther("109"));

            // post-repaid state
            expect(await mockERC721.ownerOf(tokenId)).to.equal(borrower.address);

            // Withdraw fees for both protocol and affiliate
            await expect(
                loanCore.connect(borrower).withdraw(mockERC20.address, ethers.utils.parseEther("0.45"), borrower.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, ethers.utils.parseEther("0.45"));

            // Protocol admin gets 1.35 ETH - 1.5 total fees minus 10% affiliate share on fees
            await expect(
                loanCore.connect(admin).withdrawProtocolFees(mockERC20.address, admin.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, admin.address, admin.address, ethers.utils.parseEther("4.05"));

            expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address)).to.eq(0);
            expect(await loanCore.feesWithdrawable(mockERC20.address, loanCore.address)).to.eq(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(0);
        });
    })
});
