import chai, { expect } from "chai";
import hre, { ethers, waffle } from "hardhat";
import { solidity } from "ethereum-waffle";
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
    BaseURIDescriptor,
    OriginationHelpers
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { deploy } from "./utils/contracts";
import { approve, mint } from "./utils/erc20";
import { mint as mint721 } from "./utils/erc721";
import { LoanTerms, LoanData, ItemsPredicate, Borrower, SignatureProperties } from "./utils/types";
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
    MIGRATION_MANAGER_ROLE,
    MIN_LOAN_PRINCIPAL,
    SHUTDOWN_ROLE,
    EIP712_VERSION,
    SIG_DEADLINE,
} from "./utils/constants";

chai.use(solidity);

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
    originationHelpers: OriginationHelpers;
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

const defaultSigProperties: SignatureProperties = {
    nonce: 1,
    maxUses: 1,
};

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

    const originationHelpers = <OriginationHelpers> await deploy("OriginationHelpers", admin, []);

    const originationLibrary = await deploy("OriginationLibrary", admin, []);
    const OriginationControllerFactory = await ethers.getContractFactory("OriginationController",
        {
            signer: admin,
            libraries: {
                OriginationLibrary: originationLibrary.address,
            },
        },
    );
    const originationController = <OriginationController>(
        await OriginationControllerFactory.deploy(originationHelpers.address, loanCore.address, feeController.address)
    );
    await originationController.deployed();

    // admin whitelists MockERC20 on OriginationController
    await originationHelpers.setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    // verify the currency is whitelisted
    const isWhitelisted = await originationHelpers.isAllowedCurrency(mockERC20.address);
    expect(isWhitelisted).to.be.true;
    const minPrincipal = await originationHelpers.getMinPrincipal(mockERC20.address);
    expect(minPrincipal).to.eq(MIN_LOAN_PRINCIPAL);

    // admin whitelists MockERC721 and vaultFactory on OriginationController
    await originationHelpers.setAllowedCollateralAddresses(
        [mockERC721.address, vaultFactory.address],
        [true, true]
    );
    // verify the collateral is whitelisted
    const isCollateralWhitelisted = await originationHelpers.isAllowedCollateral(mockERC721.address);
    expect(isCollateralWhitelisted).to.be.true;
    const isVaultFactoryWhitelisted = await originationHelpers.isAllowedCollateral(vaultFactory.address);
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
        originationHelpers,
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
        durationSecs = BigNumber.from(86400),
        principal = ethers.utils.parseEther("100"),
        interestRate = BigNumber.from(1000),
        collateralId = 1,
        deadline = SIG_DEADLINE,
        affiliateCode = ethers.constants.HashZero,
    }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        interestRate,
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
    affiliateCode = ethers.constants.HashZero,
    loanDuration?: BigNumber,
): Promise<LoanDef> => {
    const { originationController, feeController, mockERC20, vaultFactory, loanCore, lender, borrower } = context;
    const bundleId = terms?.collateralId ?? (await createWnft(vaultFactory, borrower));
    const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId, affiliateCode });
    if (terms) Object.assign(loanTerms, terms);
    if (loanDuration) loanTerms.durationSecs = loanDuration;

    await mint(mockERC20, lender, loanTerms.principal);

    const sigProperties: SignatureProperties = {
        nonce: nonce,
        maxUses: 1,
    };

    const sig = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        loanTerms,
        borrower,
        EIP712_VERSION,
        sigProperties,
        "b",
    );

    await approve(mockERC20, lender, originationController.address, loanTerms.principal);
    await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

    const borrowerStruct: Borrower = {
        borrower: borrower.address,
        callbackData: "0x",
    };

    const tx = await originationController
        .connect(lender)
        .initializeLoan(
            loanTerms,
            borrowerStruct,
            lender.address,
            sig,
            sigProperties,
            []
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
                originationHelpers,
                admin
            } = await loadFixture(fixture);

            // LoanCore roles
            expect(await loanCore.hasRole(ORIGINATOR_ROLE, originationController.address)).to.be.true;
            expect(await loanCore.getRoleMemberCount(ORIGINATOR_ROLE)).to.eq(1);
            expect(await loanCore.hasRole(REPAYER_ROLE, repaymentController.address)).to.be.true;
            expect(await loanCore.getRoleMemberCount(REPAYER_ROLE)).to.eq(1);
            expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, admin.address)).to.be.true;
            expect(await loanCore.getRoleMemberCount(FEE_CLAIMER_ROLE)).to.eq(1);
            expect(await loanCore.getRoleMemberCount(AFFILIATE_MANAGER_ROLE)).to.eq(0);
            expect(await loanCore.getRoleMemberCount(SHUTDOWN_ROLE)).to.eq(0);
            // CallWhitelist roles
            expect(await whitelist.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
            expect(await whitelist.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);
            expect(await whitelist.getRoleMemberCount(WHITELIST_MANAGER_ROLE)).to.eq(0);
            // FeeController owner
            expect(await feeController.owner()).to.equal(admin.address);
            // BaseURIDescriptor owner
            expect(await descriptor.owner()).to.equal(admin.address);
            // VaultFactory roles
            expect(await vaultFactory.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
            expect(await vaultFactory.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);
            expect(await vaultFactory.hasRole(FEE_CLAIMER_ROLE, admin.address)).to.be.true;
            expect(await vaultFactory.getRoleMemberCount(FEE_CLAIMER_ROLE)).to.eq(1);
            expect(await vaultFactory.getRoleMemberCount(RESOURCE_MANAGER_ROLE)).to.eq(0);
            // PromissoryNotes roles
            expect(await borrowerNote.hasRole(ADMIN_ROLE, admin.address)).to.be.false;
            expect(await borrowerNote.getRoleMemberCount(ADMIN_ROLE)).to.eq(0);
            expect(await borrowerNote.hasRole(MINT_BURN_ROLE, loanCore.address)).to.be.true;
            expect(await borrowerNote.getRoleMemberCount(MINT_BURN_ROLE)).to.eq(1);
            expect(await borrowerNote.hasRole(RESOURCE_MANAGER_ROLE, admin.address)).to.be.true;
            expect(await borrowerNote.getRoleMemberCount(RESOURCE_MANAGER_ROLE)).to.eq(1);
            expect(await lenderNote.hasRole(ADMIN_ROLE, admin.address)).to.be.false;
            expect(await lenderNote.getRoleMemberCount(ADMIN_ROLE)).to.eq(0);
            expect(await lenderNote.hasRole(MINT_BURN_ROLE, loanCore.address)).to.be.true;
            expect(await lenderNote.getRoleMemberCount(MINT_BURN_ROLE)).to.eq(1);
            expect(await lenderNote.hasRole(RESOURCE_MANAGER_ROLE, admin.address)).to.be.true;
            expect(await lenderNote.getRoleMemberCount(RESOURCE_MANAGER_ROLE)).to.eq(1);
            // OriginationController roles
            expect(await originationController.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
            expect(await originationController.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);
            expect(await originationController.hasRole(MIGRATION_MANAGER_ROLE, admin.address)).to.be.true;
            expect(await originationController.getRoleMemberCount(MIGRATION_MANAGER_ROLE)).to.eq(1);
            // originationHelpers roles
            expect(await originationHelpers.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
            expect(await originationHelpers.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);
            expect(await originationHelpers.hasRole(WHITELIST_MANAGER_ROLE, admin.address)).to.be.true;
            expect(await originationHelpers.getRoleMemberCount(WHITELIST_MANAGER_ROLE)).to.eq(1);
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
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            const borrowerStruct: Borrower = {
                borrower: borrower.address,
                callbackData: "0x",
            };

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(lender.address, borrower.address, loanTerms.principal)
                .to.emit(loanCore, "LoanStarted");

            // nonce validation
            expect(await loanCore.connect(borrower).numberOfNonceUses(borrower.address, 1)).to.eq(1);
            expect(await loanCore.connect(borrower).isNonceUsed(borrower.address, 1)).to.be.true;
        });

        it("should fail to start loan if wNFT has withdraws enabled", async () => {
            const { originationController, mockERC20, vaultFactory, lender, borrower } = await loadFixture(fixture);

            const bundleId = await createWnft(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            // call enableWithdraw before initializing the loan
            await AssetVault__factory.connect(bundleId, borrower).connect(borrower).enableWithdraw();

            const borrowerStruct: Borrower = {
                borrower: borrower.address,
                callbackData: "0x",
            };

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            ).to.be.revertedWith("VF_NoTransferWithdrawEnabled");
        });

        it("should fail to create a loan with nonexistent collateral", async () => {
            const { originationController, mockERC20, lender, borrower, vaultFactory } = await loadFixture(fixture);

            const mockOpenVault = await deploy("MockOpenVault", borrower, []);
            const bundleId = mockOpenVault.address;
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const borrowerStruct: Borrower = {
                borrower: borrower.address,
                callbackData: "0x",
            };

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            ).to.be.revertedWith("ERC721: operator query for nonexistent token");
        });

        it("should fail to create a loan with passed due date", async () => {
            const { originationController, mockERC20, vaultFactory, lender, borrower } = await loadFixture(fixture);
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
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            const borrowerStruct: Borrower = {
                borrower: borrower.address,
                callbackData: "0x",
            };

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        []
                    ),
            ).to.be.revertedWith("OCC_LoanDuration");
        });
    });

    describe("Repay Loan", function () {
        it("should successfully repay loan with prorated interest", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender } = context;
            const { loanId, loanTerms, loanData, bundleId } = await initializeLoan(context, 1);

            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest = await repaymentController.getProratedInterestAmount(
                loanTerms.principal,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                loanData.startDate,
                loanData.startDate,
                t1
            );
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);
            const preLenderBalance = await mockERC20.balanceOf(lender.address);

            await expect(repaymentController.connect(borrower).repay(loanId, repayAmount))
                .to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(mockERC20, "Transfer").withArgs(borrower.address, loanCore.address, repayAmount);

            // check loan state
            const loan: LoanData = await loanCore.getLoan(loanId);
            expect(loan.state).to.equal(2); // repaid

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);
            const postLenderBalance = await mockERC20.balanceOf(lender.address);
            expect(postLenderBalance.sub(preLenderBalance)).to.equal(repayAmount);
        });

        it("should allow the collateral to be reused after repay", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, loanCore, borrower } = context;
            const { loanId, loanTerms, loanData, bundleId } = await initializeLoan(context, 1);

            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest = await repaymentController.getProratedInterestAmount(
                loanTerms.principal,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                loanData.startDate,
                loanData.startDate,
                t1
            );
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await expect(repaymentController.connect(borrower).repay(loanId, repayAmount))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId);

            // check loan state
            const loan: LoanData = await loanCore.getLoan(loanId);
            expect(loan.state).to.equal(2); // repaid

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

            const grossInterest = loanTerms.principal.mul(loanTerms.interestRate).div(ethers.utils.parseEther("10000"));
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);

            await expect(repaymentController.connect(borrower).repay(loanId, repayAmount)).to.be.revertedWith(
                "ERC20: transfer amount exceeds allowance",
            );
        });

        it("fails with invalid note ID", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower } = context;
            const { loanTerms, loanData } = await initializeLoan(context, 1);

            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest = await repaymentController.getProratedInterestAmount(
                loanTerms.principal,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                loanData.startDate,
                loanData.startDate,
                t1
            );
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20.connect(borrower).approve(repaymentController.address, repayAmount);

            await expect(repaymentController.connect(borrower).repay(1234, repayAmount))
                .to.be.revertedWith("RC_InvalidState");
        });
    });

    describe("Claim loan", function () {
        it("should successfully claim loan", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, vaultFactory, loanCore, lender } = context;
            const { loanId, bundleId } = await initializeLoan(context, 1, undefined, ethers.constants.HashZero, BigNumber.from(3600));

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
            const { loanId, bundleId } = await initializeLoan(context, 1, undefined, ethers.constants.HashZero, BigNumber.from(3600));

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
            const { loanId: newLoanId } = await initializeLoan(context, 20, undefined, ethers.constants.HashZero, BigNumber.from(3600));
            // initializeLoan asserts loan created successfully based on logs, so test that new loan is a new instance
            expect(newLoanId !== loanId);
        });

        it("fails if not past durationSecs", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, lender } = context;
            const { loanId } = await initializeLoan(context, 1, undefined, ethers.constants.HashZero, BigNumber.from(3600));

            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_NotExpired");
        });

        it("fails for invalid noteId", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, lender } = context;

            await blockchainTime.increaseTime(3600); // increase past loan duration
            await blockchainTime.increaseTime(600); // increase past grace period

            await expect(repaymentController.connect(lender).claim(1234)).to.be.revertedWith("RC_InvalidState");
        });

        it("fails if not called by lender", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, borrower } = context;
            const { loanId } = await initializeLoan(context, 1, undefined, ethers.constants.HashZero, BigNumber.from(3600));

            await blockchainTime.increaseTime(3600); // increase past loan duration
            await blockchainTime.increaseTime(600); // increase past grace period

            await expect(repaymentController.connect(borrower).claim(loanId)).to.be.revertedWith("RC_OnlyLender");
        });
    });

    describe("End-to-end", () => {
        it("full loan cycle, no fees", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender } = context;

            const { loanId, loanTerms, loanData, bundleId } = await initializeLoan(context, 1);

            // get block timestamp the repayment call will be made at
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest = await repaymentController.getProratedInterestAmount(
                loanTerms.principal,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                loanData.startDate,
                loanData.startDate,
                t1
            );
            const repayAmount = loanTerms.principal.add(grossInterest);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            await expect(repaymentController.connect(borrower).repay(loanId, repayAmount))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(mockERC20, "Transfer")
                .withArgs(borrower.address, loanCore.address, repayAmount)
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, repayAmount);

            // check loan state
            const loan: LoanData = await loanCore.getLoan(loanId);
            expect(loan.state).to.equal(2); // repaid

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);

            // No fees accrued
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(0);
        });

        it("full loan cycle, with realistic fees and registered affiliate", async () => {
            const context = await loadFixture(fixture);
            const { feeController, repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, admin } = context;


            // 10% fee on interest. Total fees earned should be 1 ETH
            await feeController.setLendingFee(await feeController.FL_01(), 10_00);

            // Set affiliate share to 10% of fees for borrower
            await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, admin.address);
            const code = ethers.utils.id("BORROWER_A");
            await loanCore.connect(admin).setAffiliateSplits([code], [{ affiliate: borrower.address, splitBps: 10_00 }]);
            const { loanId, loanTerms, loanData, bundleId } = await initializeLoan(context, 1, undefined, code);

            // get block timestamp the repayment call will be made at
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest = await repaymentController.getProratedInterestAmount(
                loanTerms.principal,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                loanData.startDate,
                loanData.startDate,
                t1
            );
            const repayAmount = loanTerms.principal.add(grossInterest);
            const interestFee = grossInterest.mul(1000).div(10000);
            const lenderRepayment = repayAmount.sub(interestFee);
            const totalFees = interestFee;
            const affiliateFee = totalFees.mul(1000).div(10000);
            const protocolFee = totalFees.sub(affiliateFee);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            await expect(repaymentController.connect(borrower).repay(loanId, repayAmount))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(mockERC20, "Transfer")
                .withArgs(borrower.address, loanCore.address, repayAmount)
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, lenderRepayment);

            // check loan state
            const loan: LoanData = await loanCore.getLoan(loanId);
            expect(loan.state).to.equal(2); // repaid

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);

            // Withdraw fees for both protocol and affiliate
            await expect(
                loanCore.connect(borrower).withdraw(mockERC20.address, affiliateFee, borrower.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, affiliateFee);

            // Protocol admin gets 1.35 ETH - 1.5 total fees minus 10% affiliate share on fees
            await expect(
                loanCore.connect(admin).withdrawProtocolFees(mockERC20.address, admin.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, admin.address, admin.address, protocolFee);

            // All fees withdrawn
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(0);
        });

        it("full loan cycle, with realistic fees and registered affiliate, two-step repay", async () => {
            const context = await loadFixture(fixture);
            const { feeController, repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, admin, lenderNote } = context;

            // 10% fee on interest. Total fees earned should be 1 ETH
            await feeController.setLendingFee(await feeController.FL_01(), 10_00);

            // Set affiliate share to 10% of fees for borrower
            await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, admin.address);
            const code = ethers.utils.id("BORROWER_A");
            await loanCore.connect(admin).setAffiliateSplits([code], [{ affiliate: borrower.address, splitBps: 10_00 }]);
            const { loanId, loanTerms, loanData, bundleId } = await initializeLoan(context, 1, undefined, code);

            // get block timestamp the repayment call will be made at
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest = await repaymentController.getProratedInterestAmount(
                loanTerms.principal,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                loanData.startDate,
                loanData.startDate,
                t1
            );
            const repayAmount = loanTerms.principal.add(grossInterest);
            const interestFee = grossInterest.mul(1000).div(10000);
            const lenderRepayment = repayAmount.sub(interestFee);
            const totalFees = interestFee;
            const affiliateFee = totalFees.mul(1000).div(10000);
            const protocolFee = totalFees.sub(affiliateFee);

            await mint(mockERC20, borrower, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            await expect(repaymentController.connect(borrower).forceRepay(loanId, repayAmount))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "ForceRepay")
                .withArgs(loanId)
                .to.emit(mockERC20, "Transfer")
                .withArgs(borrower.address, loanCore.address, repayAmount);

            // check loan state
            const loan: LoanData = await loanCore.getLoan(loanId);
            expect(loan.state).to.equal(2); // repaid

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);
            expect(await lenderNote.ownerOf(loanId)).to.equal(lender.address);

            // redeem the note to complete the repay flow
            await expect(repaymentController.connect(lender).redeemNote(loanId, lender.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, lender.address, loanId, lenderRepayment)
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, lenderRepayment);

            // Withdraw fees for both protocol and affiliate
            await expect(
                loanCore.connect(borrower).withdraw(mockERC20.address, affiliateFee, borrower.address)
            ).to.emit(loanCore, "FeesWithdrawn")
               .withArgs(mockERC20.address, borrower.address, borrower.address, affiliateFee);

            // Protocol admin gets protocol fees minus 10% affiliate share on fees
            await expect(
                loanCore.connect(admin).withdrawProtocolFees(mockERC20.address, admin.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, admin.address, admin.address, protocolFee);

            // All fees withdrawn
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(0);
        });

        it("full loan cycle, with realistic fees and registered affiliate, on an unvaulted asset with a rollover", async () => {
            const context = await loadFixture(fixture);
            const { feeController, repaymentController, originationController, originationHelpers, mockERC20, mockERC721, loanCore, borrower, lender, admin } = context;

            const uvVerifier = <ArcadeItemsVerifier>await deploy("UnvaultedItemsVerifier", admin, []);
            await originationHelpers.setAllowedVerifiers([uvVerifier.address], [true]);
            await originationHelpers.setAllowedCollateralAddresses([mockERC721.address], [true]);

            // 10% fee on interest.
            await feeController.setLendingFee(await feeController.FL_01(), 10_00);

            // Set affiliate share to 10% of fees for borrower
            await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, admin.address);
            const code = ethers.utils.id("BORROWER_A");
            await loanCore.connect(admin).setAffiliateSplits([code], [{ affiliate: borrower.address, splitBps: 10_00 }]);

            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).approve(originationController.address, tokenId);
            const loanTerms = createLoanTerms(mockERC20.address, mockERC721.address, {
                collateralId: tokenId,
                affiliateCode: code,
                durationSecs: 31536000
            });

            const predicates: ItemsPredicate[] = [
                {
                    verifier: uvVerifier.address,
                    data: encodeItemCheck(mockERC721.address, 0, true),
                }
            ];

            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const borrowerStruct: Borrower = {
                borrower: borrower.address,
                callbackData: "0x",
            };

            expect(await originationController
                .connect(lender)
                .initializeLoan(
                    loanTerms,
                    borrowerStruct,
                    lender.address,
                    sig,
                    defaultSigProperties,
                    predicates
                )
            ).to.emit(loanCore, "LoanStarted");

            // no fees accrued
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(0);

            const loanId = 1;

            const rolloverPredicates: ItemsPredicate[] = [
                {
                    verifier: uvVerifier.address,
                    data: encodeItemCheck(mockERC721.address, tokenId, false),
                }
            ];

            const rolloverSigProperties: SignatureProperties = {
                nonce:2,
                maxUses:1
            };
            const rolloverSig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                rolloverPredicates,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            const loanData: LoanData = await loanCore.getLoan(1);

            // fast forward to half way through loan duration
            await blockchainTime.increaseTime(31536000 / 2 - 3);

            // get block timestamp the repayment call will be made at
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest = await repaymentController.getProratedInterestAmount(
                loanTerms.principal,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                loanData.startDate,
                loanData.startDate,
                t1
            ); // 5e18
            const interestFee = grossInterest.mul(1000).div(10000); // 0.5e18
            const lenderReceives = grossInterest.sub(interestFee); // 5e18 - 0.5e18 = 4.5e18
            const borrowerRepayment = grossInterest; // 5e18
            let totalFees = interestFee; // 0.5e18

            await mint(mockERC20, borrower, borrowerRepayment);
            await approve(mockERC20, borrower, originationController.address, borrowerRepayment);

            const newLoanId = 2;

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);

            await expect(originationController.connect(borrower).rolloverLoan(
                loanId,
                loanTerms,
                lender.address,
                rolloverSig,
                rolloverSigProperties,
                rolloverPredicates
            ))
            .to.emit(loanCore, "LoanRepaid")
            .withArgs(loanId)
            .to.emit(loanCore, "LoanStarted")
            .withArgs(newLoanId, lender.address, borrower.address)
            .to.emit(loanCore, "LoanRolledOver")
            .withArgs(loanId, newLoanId)
            .to.emit(mockERC20, "Transfer")
            .withArgs(borrower.address, originationController.address, borrowerRepayment)
            .to.emit(mockERC20, "Transfer")
            .withArgs(loanCore.address, lender.address, lenderReceives);

            // check loan state
            const oldLoan: LoanData = await loanCore.getLoan(loanId);
            expect(oldLoan.state).to.equal(2); // repaid
            const newLoan: LoanData = await loanCore.getLoan(newLoanId);
            expect(newLoan.state).to.equal(1); // active

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays interest + borrower fee
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(borrowerRepayment);
            // Lender collects interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(lenderReceives);
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates borrower fee
            expect(loanCoreBalanceAfter).to.eq(totalFees);

            // pre-repaid state
            expect(await mockERC721.ownerOf(tokenId)).to.equal(loanCore.address);

            // get loan data for new loan
            const newLoanData: LoanData = await loanCore.getLoan(newLoanId);

            // fast forward to half way through loan duration
            await blockchainTime.increaseTime(31536000 / 2 - 3);

            // get block timestamp the repayment call will be made at
            const t2 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest2 = await repaymentController.getProratedInterestAmount(
                loanTerms.principal,
                loanTerms.interestRate,
                loanTerms.durationSecs,
                newLoanData.startDate,
                newLoanData.startDate,
                t2
            ); // 5e18
            const repayAmount2 = loanTerms.principal.add(grossInterest2); // 100e18 + 5e18 = 105e18
            const interestFee2 = grossInterest2.mul(1000).div(10000); // 0.5e18
            totalFees = totalFees.add(interestFee2); // 7.5e18 + 0.5e18 = 8.0e18
            const affiliateFee = totalFees.mul(1000).div(10000); // 8.0e18 * 10% = 0.8e18
            const protocolFee = totalFees.sub(affiliateFee); // 8.0e18 - 0.8e18 = 7.2e18

            await mint(mockERC20, borrower, repayAmount2);
            await approve(mockERC20, borrower, loanCore.address, repayAmount2);

            // Repay - loan was for same terms, so will earn
            await expect(repaymentController.connect(borrower).repayFull(newLoanId))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(newLoanId)
                .to.emit(mockERC20, "Transfer")
                .withArgs(borrower.address, loanCore.address, repayAmount2)
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, repayAmount2.sub(interestFee2));

            // check balance of loanCore after repay
            const loanCoreBalanceAfter2 = await mockERC20.balanceOf(loanCore.address);
            expect(loanCoreBalanceAfter2).to.eq(totalFees);

            // check loan state
            const loan2: LoanData = await loanCore.getLoan(newLoanId);
            expect(loan2.state).to.equal(2); // repaid

            // post-repaid state
            expect(await mockERC721.ownerOf(tokenId)).to.equal(borrower.address);

            // Withdraw fees for both protocol and affiliate
            await expect(
                loanCore.connect(borrower).withdraw(mockERC20.address, affiliateFee, borrower.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, affiliateFee);

            // Protocol admin gets protocol fees minus 10% affiliate share on fees
            await expect(
                loanCore.connect(admin).withdrawProtocolFees(mockERC20.address, admin.address)
            ).to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, admin.address, admin.address, protocolFee);

            expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address)).to.eq(0);
            expect(await loanCore.feesWithdrawable(mockERC20.address, loanCore.address)).to.eq(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(0);
        });
    })
});
