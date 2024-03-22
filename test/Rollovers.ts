import chai, { expect } from "chai";
import { ethers, waffle } from "hardhat";
import { solidity } from "ethereum-waffle";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber, BigNumberish } from "ethers";

chai.use(solidity);

import {
    VaultFactory,
    CallWhitelist,
    AssetVault,
    ArcadeItemsVerifier,
    FeeController,
    OriginationController,
    PromissoryNote,
    RepaymentController,
    LoanCore,
    MockERC20,
    MockERC721,
    BaseURIDescriptor,
    OriginationConfiguration
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { mint as mint721 } from "./utils/erc721";
import { deploy } from "./utils/contracts";
import { approve, mint } from "./utils/erc20";
import { LoanTerms, LoanData, ItemsPredicate, SignatureItem, Borrower, SignatureProperties } from "./utils/types";
import { createLoanTermsSignature, createLoanItemsSignature } from "./utils/eip712";
import { encodeSignatureItems } from "./utils/loans";

import {
    ORIGINATOR_ROLE,
    REPAYER_ROLE,
    AFFILIATE_MANAGER_ROLE,
    BASE_URI,
    MIN_LOAN_PRINCIPAL,
    EIP712_VERSION
} from "./utils/constants";

interface TestContext {
    loanCore: LoanCore;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    borrowerNote: PromissoryNote;
    lenderNote: PromissoryNote;
    vaultFactory: VaultFactory;
    feeController: FeeController;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    originationConfiguration: OriginationConfiguration;
    borrower: SignerWithAddress;
    lender: SignerWithAddress;
    admin: SignerWithAddress;
    newLender: SignerWithAddress;
    currentTimestamp: number;
    blockchainTime: BlockchainTime;
    verifier: ArcadeItemsVerifier;
}

interface LoanDef {
    loanId: string;
    bundleId: BigNumberish;
    loanTerms: LoanTerms;
    loanData: LoanData;
}

/**
 * Sets up a test context, deploying new contracts and returning them for use in a test
 */
const fixture = async (): Promise<TestContext> => {
    const blockchainTime = new BlockchainTime();
    const currentTimestamp = await blockchainTime.secondsFromNow(0);

    const signers: SignerWithAddress[] = await ethers.getSigners();
    const [borrower, lender, admin, newLender] = signers;

    const whitelist = <CallWhitelist>await deploy("CallWhitelist", signers[0], []);
    const vaultTemplate = <AssetVault>await deploy("AssetVault", signers[0], []);
    const feeController = <FeeController>await deploy("FeeController", admin, []);
    const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI])
    const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address]);

    const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN", descriptor.address]);
    const lenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN", descriptor.address]);

    const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [borrowerNote.address, lenderNote.address]);

    // Grant correct permissions for promissory note
    for (const note of [borrowerNote, lenderNote]) {
        await note.connect(admin).initialize(loanCore.address);
    }

    const updateborrowerPermissions = await loanCore.grantRole(ORIGINATOR_ROLE, borrower.address);
    await updateborrowerPermissions.wait();

    const mockERC20 = <MockERC20>await deploy("MockERC20", admin, ["Mock ERC20", "MOCK"]);
    const mockERC721 = <MockERC721>await deploy("MockERC721", admin, ["Mock ERC721", "MOCK"]);

    const repaymentController = <RepaymentController>await deploy("RepaymentController", admin, [loanCore.address, feeController.address]);
    await repaymentController.deployed();
    const updateRepaymentControllerPermissions = await loanCore.grantRole(
        REPAYER_ROLE,
        repaymentController.address,
    );
    await updateRepaymentControllerPermissions.wait();

    const originationConfiguration = <OriginationConfiguration> await deploy("OriginationConfiguration", admin, []);

    const originationLibrary = await deploy("OriginationLibrary", admin, []);
    const OriginationControllerFactory = await ethers.getContractFactory("OriginationController",
        {
            signer: signers[0],
            libraries: {
                OriginationLibrary: originationLibrary.address,
            },
        },
    );
    const originationController = <OriginationController>(
        await OriginationControllerFactory.deploy(originationConfiguration.address, loanCore.address, feeController.address)
    );
    await originationController.deployed();

    // admin whitelists MockERC20 on OriginationController
    await originationConfiguration.setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    // verify the currency is whitelisted
    const isWhitelisted = await originationConfiguration.isAllowedCurrency(mockERC20.address);
    expect(isWhitelisted).to.be.true;
    const minPrincipal = await originationConfiguration.getMinPrincipal(mockERC20.address);
    expect(minPrincipal).to.eq(MIN_LOAN_PRINCIPAL);

    // admin whitelists MockERC721 and vaultFactory on OriginationController
    await originationConfiguration.setAllowedCollateralAddresses(
        [mockERC721.address, vaultFactory.address],
        [true, true]
    );
    // verify the collateral is whitelisted
    const isCollateralWhitelisted = await originationConfiguration.isAllowedCollateral(mockERC721.address);
    expect(isCollateralWhitelisted).to.be.true;
    const isVaultFactoryWhitelisted = await originationConfiguration.isAllowedCollateral(vaultFactory.address);
    expect(isVaultFactoryWhitelisted).to.be.true;

    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, admin.address);

    const verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", admin, []);
    await originationConfiguration.setAllowedVerifiers([verifier.address], [true]);

    return {
        loanCore,
        borrowerNote,
        lenderNote,
        vaultFactory,
        feeController,
        repaymentController,
        originationController,
        originationConfiguration,
        mockERC20,
        borrower,
        lender,
        admin,
        newLender,
        currentTimestamp,
        blockchainTime,
        mockERC721,
        verifier,
    };
};

/**
 * Create a LoanTerms object using the given parameters, or defaults
 */
const createLoanTerms = async (
    payableCurrency: string,
    collateralAddress: string,
    {
        durationSecs = BigNumber.from(3600000),
        principal = ethers.utils.parseEther("100"),
        interestRate = BigNumber.from(1),
        collateralId = 1,
        deadline = 604800, // 1 week from now
        affiliateCode = ethers.constants.HashZero
    }: Partial<LoanTerms> = {},
): Promise<LoanTerms> => {
    // add deadline to current block timestamp
    const block = await ethers.provider.getBlockNumber();
    const currentTime: number = await ethers.provider.getBlock(block).then((block: any) => block.timestamp);
    const futureDeadline = currentTime + BigNumber.from(deadline).toNumber();

    return {
        durationSecs,
        principal,
        interestRate,
        collateralAddress,
        collateralId,
        payableCurrency,
        deadline: futureDeadline,
        affiliateCode
    };
};

const initializeBundle = async (vaultFactory: VaultFactory, user: SignerWithAddress): Promise<BigNumber> => {
    const tx = await vaultFactory.connect(user).initializeBundle(user.address);
    const receipt = await tx.wait();

    if (receipt && receipt.events) {
        for (const event of receipt.events) {
            if (event.event && event.event === "VaultCreated" && event.args && event.args.vault) {
                return event.args.vault;
            }
        }
        throw new Error("Unable to initialize bundle");
    } else {
        throw new Error("Unable to initialize bundle");
    }
};

const initializeLoan = async (
    context: TestContext,
    payableCurrency: string,
    durationSecs: BigNumberish,
    principal: BigNumber,
    interestRate: BigNumber,
    deadline: BigNumberish,
    nonce = 1,
    affiliateCode = ethers.constants.HashZero
): Promise<LoanDef> => {
    const { originationController, mockERC20, vaultFactory, loanCore, lender, borrower } = context;
    const bundleId = await initializeBundle(vaultFactory, borrower);
    const loanTerms = await createLoanTerms(payableCurrency, vaultFactory.address, {
        durationSecs,
        principal,
        interestRate,
        deadline,
        collateralId: bundleId,
        affiliateCode
    });

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

describe("Rollovers", () => {
    const DURATION = 31536000; // 1 yr
    const DEADLINE = 31536000; // 1 yr
    const affiliateCode = ethers.utils.id("FOO");
    const affiliateCode2 = ethers.utils.id("BAR");
    const rolloverSigProperties: SignatureProperties = {nonce: 2, maxUses: 1};

    describe("Rollover Loan", () => {
        let ctx: TestContext;
        let loan: LoanDef;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);

            loan = await initializeLoan(
                ctx,
                ctx.mockERC20.address,
                BigNumber.from(DURATION),
                ethers.utils.parseEther("100"), // principal
                BigNumber.from(1000), // interest
                DEADLINE,
                1,
                affiliateCode
            );
        });

        it("should not allow a rollover if the collateral doesn't match", async () => {
            const { originationController, vaultFactory, borrower, lender, } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(
                ctx.mockERC20.address,
                vaultFactory.address,
                { ...loanTerms, collateralId: BigNumber.from(bundleId).add(1) }, // different bundle ID
            );

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, []),
            ).to.be.revertedWith("OC_RolloverCollateralMismatch");
        });

        it("should not allow a rollover if the loan currencies don't match", async () => {
            const { originationController, originationConfiguration, vaultFactory, borrower, lender, admin } = ctx;
            const { loanId, loanTerms } = loan;

            const otherERC20 = <MockERC20>await deploy("MockERC20", admin, ["Mock ERC20", "MOCK"]);
            await originationConfiguration.setAllowedPayableCurrencies([otherERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(
                otherERC20.address, // different currency
                vaultFactory.address,
                loanTerms
            );

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, []),
            ).to.be.revertedWith("OC_RolloverCurrencyMismatch");
        });

        it("should not allow a rollover on an already closed loan", async () => {
            const { originationController, loanCore, repaymentController, mockERC20, vaultFactory, borrower, lender, admin } =
                ctx;
            const { loanId, loanTerms } = loan;

            // Repay the loan
            await mockERC20.connect(admin).mint(borrower.address, ethers.utils.parseEther("1000"));
            await mockERC20.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("1000"));
            await repaymentController.connect(borrower).repay(loanId, ethers.utils.parseEther("1000"));

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, []),
            ).to.be.revertedWith("OC_InvalidState");
        });

        it("should not allow a rollover if called by a third party", async () => {
            const { originationController, mockERC20, vaultFactory, lender, newLender } = ctx;
            const { loanId, loanTerms } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            await expect(
                // newLender not a counterparty
                originationController.connect(newLender).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, []),
            ).to.be.revertedWith("OC_CallerNotParticipant");
        });

        it("should not allow a rollover if signed by the old lender", async () => {
            const { originationController, mockERC20, vaultFactory, borrower, lender, newLender } = ctx;
            const { loanId, loanTerms } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            await expect(
                // newLender not a counterparty
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, rolloverSigProperties, []),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("should not allow a rollover if called by the old lender", async () => {
            const { originationController, mockERC20, vaultFactory, lender, newLender } = ctx;
            const { loanId, loanTerms } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            await expect(
                // newLender not a counterparty
                originationController.connect(lender).rolloverLoan(loanId, newTerms, newLender.address, sig, rolloverSigProperties, []),
            ).to.be.revertedWith("OC_CallerNotParticipant");
        });

        it("should rollover to the same lender", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            // approve more than enough to rollover
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            // use increased gas limit to prevent "out of gas" error
            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, [], { gasLimit: 5000000 }))
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

            // Borrower pays interest
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10"));
            // Lender collects interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("10"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates 0 fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(0);

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should fail to rollover an already closed loan", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            // approve more than enough to rollover
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("25"));

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            // use increased gas limit to prevent "out of gas" error
            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, [], { gasLimit: 5000000 }))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, lender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            // Try to roll over again
            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, []),
            ).to.be.revertedWith("OC_InvalidState");
        });

        it("should rollover to a different lender", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sigProperties: SignatureProperties = {nonce: 1, maxUses: 1};
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );

            // approve more than enough to rollover
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("100"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("100"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 5);

            await expect(
                await originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, sigProperties, [])
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays interest
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10"));
            // Old lender collects full principal + interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("110"));
            // New lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("100"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates 0 fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(0);

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to a different lender, called by the lender", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                borrower,
                EIP712_VERSION,
                rolloverSigProperties,
                "b",
            );

            // approve more than enough to rollover
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("100"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("100"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 5);

            await expect(
                originationController.connect(newLender).rolloverLoan(loanId, newTerms, newLender.address, sig, rolloverSigProperties, []),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays interest
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10"));
            // Old lender collects full principal + interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("110"));
            // New lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("100"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates 0 fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(0);

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("rollover with items signature reverts if the required predicates array is empty", async () => {
            const {
                originationController,
                mockERC20,
                mockERC721,
                vaultFactory,
                borrower,
                newLender
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            const collateralId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleId.toString(), collateralId);

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);
            const predicates: ItemsPredicate[] = [];

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                predicates,
                newLender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            await expect(
                originationController
                    .connect(borrower)
                    .rolloverLoan(loanId, newTerms, newLender.address, sig, rolloverSigProperties, predicates),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("rollover with items signature reverts if the verifier is not approved", async () => {
            const {
                originationController,
                originationConfiguration,
                mockERC20,
                mockERC721,
                vaultFactory,
                borrower,
                newLender,
                verifier
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            const collateralId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleId.toString(), collateralId);

            // Remove verifier approval
            await originationConfiguration.setAllowedVerifiers([verifier.address], [false]);

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            await mint(mockERC20, newLender, newTerms.principal);
            await approve(mockERC20, newLender, originationController.address, newTerms.principal);

            await mint(mockERC20, borrower, ethers.utils.parseEther("12"));
            await approve(mockERC20, borrower, originationController.address, ethers.utils.parseEther("12"));

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: collateralId,
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

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                predicates,
                newLender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            await expect(
                originationController
                    .connect(borrower)
                    .rolloverLoan(loanId, newTerms, newLender.address, sig, rolloverSigProperties, predicates),
            ).to.be.revertedWith("OC_InvalidVerifier");
        });

        it("rollover with items signature reverts if invalid collateral in predicates", async () => {
            const {
                originationController,
                mockERC20,
                mockERC721,
                vaultFactory,
                borrower,
                newLender,
                verifier,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // borrower approves interest
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("11.1"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("11.1"));

            const collateralId = await mint721(mockERC721, borrower);
            const collateralId2 = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleId.toString(), collateralId);

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: collateralId2, // look for the other, non-vaulted collateral
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

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                predicates,
                newLender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            await mint(mockERC20, newLender, newTerms.principal);
            await approve(mockERC20, newLender, originationController.address, newTerms.principal);

            await expect(
                originationController
                    .connect(borrower)
                    .rolloverLoan(loanId, newTerms, newLender.address, sig, rolloverSigProperties, predicates),
            ).to.be.revertedWith("OC_PredicateFailed");
        });

        it("rollover with items signature reverts if already repaid", async () => {
            const {
                originationController,
                mockERC20,
                mockERC721,
                vaultFactory,
                borrower,
                lender,
                loanCore,
                verifier,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            const collateralId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleId.toString(), collateralId);

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: collateralId,
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

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                predicates,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            // approve more than enough to rollover
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                originationController
                    .connect(borrower)
                    .rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, predicates),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, lender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            await expect(
                originationController
                    .connect(borrower)
                    .rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, predicates),
            ).to.be.revertedWith("OC_InvalidState");
        });

        it("should rollover to a different lender using an items signature", async () => {
            const {
                originationController,
                mockERC20,
                mockERC721,
                vaultFactory,
                borrower,
                lender,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                verifier,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            const collateralId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleId.toString(), collateralId);

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: collateralId,
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

            const sigProperties: SignatureProperties = {nonce: 1, maxUses: 1};
            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                predicates,
                newLender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );

            // approve more than enough to rollover
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("100"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("100"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 5);

            await expect(
                originationController
                    .connect(borrower)
                    .rolloverLoan(loanId, newTerms, newLender.address, sig, sigProperties, predicates),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays interest
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10"));
            // Old lender collects full principal + interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("110"));
            // New lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("100"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates 0 fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(0);

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to the same lender using an items signature", async () => {
            const {
                originationController,
                mockERC20,
                mockERC721,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
                verifier,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            const collateralId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleId.toString(), collateralId);

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const signatureItems: SignatureItem[] = [
                {
                    cType: 0,
                    asset: mockERC721.address,
                    tokenId: collateralId,
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

            const sig = await createLoanItemsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                predicates,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            // approve more than enough to rollover
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                originationController
                    .connect(borrower)
                    .rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, predicates),
            )
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

            // Borrower pays interest
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10"));
            // Lender collects interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("10"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates 0 fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(0);

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover a loan with extra principal for the borrower and the same lender", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("200")
            });

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            // approve more than enough to rollover
            await mockERC20.mint(lender.address, ethers.utils.parseEther("100"));
            await mockERC20.connect(lender).approve(originationController.address, ethers.utils.parseEther("100"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, []))
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

            // Borrower gets principal difference - interest
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.eq(ethers.utils.parseUnits("90"));
            // Lender pays new principal - amount due - interest
            expect(lenderBalanceBefore.sub(lenderBalanceAfter)).to.eq(ethers.utils.parseUnits("90"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates 0 fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(0);

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover a loan with extra principal for the borrower and a different lender", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("200")
            });

            const sigProperties: SignatureProperties = {nonce: 1, maxUses: 1};
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );

            // approve more than enough to rollover
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("200"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("200"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, sigProperties, []),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower gets principal difference - interest
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.eq(ethers.utils.parseUnits("90"));
            // Old lender collects full principal + interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("110"));
            // Lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("200"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates 0 fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(0);

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });
    });

    describe("Rollover Fees", () => {
        let ctx: TestContext;
        let loan: LoanDef;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);

            // set interest fee to 1% and principal fee to 1%
            await ctx.feeController.setLendingFee(await ctx.feeController.FL_01(), 100);
            await ctx.feeController.setLendingFee(await ctx.feeController.FL_02(), 100);

            loan = await initializeLoan(
                ctx,
                ctx.mockERC20.address,
                BigNumber.from(DURATION),
                ethers.utils.parseEther("100"), // principal
                BigNumber.from(1000), // interest
                DEADLINE,
                1,
                affiliateCode
            );
        });

        it("should rollover to the same lender, with fees", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            // borrower approves interest
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            // use increased gas limit to prevent "out of gas" error
            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, [], { gasLimit: 1000000 }))
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

            // Borrower pays interest
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10"));
            // Lender collects interest, minus 1% fee on interest and 1% fee on principal
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("8.9"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore collects fees from payment to the lender
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to the same lender, sending extra principal, with fees", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("200"),
            });

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            // lender approves the new principal plus fees
            await mockERC20.mint(lender.address, ethers.utils.parseEther("91.1"));
            await mockERC20.connect(lender).approve(originationController.address, ethers.utils.parseEther("91.1"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, []))
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

            // Borrower gets principal difference - interest
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.eq(ethers.utils.parseUnits("90"));
            // Lender pays new principal - amount due - interest - 1% fee on interest - 1% fee on principal
            expect(lenderBalanceBefore.sub(lenderBalanceAfter)).to.eq(ethers.utils.parseUnits("91.1"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to the same lender, new principal covers repayment amount, with repayment fees", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("110"),
            });

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            // lender will have to pay the interest and principal fees
            await mockERC20.mint(lender.address, ethers.utils.parseEther("1.1"));
            await mockERC20.connect(lender).approve(originationController.address, ethers.utils.parseEther("1.1"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // fast forward past loan expiration
            await blockchainTime.increaseTime(31536000);

            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, []))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, lender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const oldLenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays original fee
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(0);
            // lender pays 1% fee on principal + 1% fee on interest
            expect(oldLenderBalanceBefore.sub(oldLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("1.1"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates origination fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to the same lender, borrower pays more than interest, with repayment fees", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("70"),
            });

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                EIP712_VERSION,
                rolloverSigProperties,
                "l",
            );

            // borrower will have to pay difference in principal + interest
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("40"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("40"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // fast forward past loan expiration
            await blockchainTime.increaseTime(31536000);

            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, rolloverSigProperties, []))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, lender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const oldLenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays interest + principal difference
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("40"));
            // lender collects principal + interest - 1% fee on principal - 1% fee on interest
            expect(oldLenderBalanceAfter.sub(oldLenderBalanceBefore)).to.eq(ethers.utils.parseUnits("38.9"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates origination fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to a different lender, with fees", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                feeController,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);
            const sigProperties: SignatureProperties = {nonce: 1, maxUses: 1};
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );

            // borrower pays interest
            // lender pays principal + old principal fee
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("100"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("100"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 5);

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, sigProperties, [], { gasLimit: 5000000 }),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays interest
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10"));
            // Old lender collects full principal + interest - 1% fee on interest - 1% fee on principal
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("108.9"));
            // New lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("100"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates origination fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to a different lender, sending extra principal, with fees", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                feeController,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("200"),
            });
            const sigProperties: SignatureProperties = {nonce: 1, maxUses: 1};
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );

            // borrower approves interest
            // new lender approves new principal + 1% fee on old principal
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("200"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("200"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 5);

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, sigProperties, []),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower gets principal difference - interest - origination fee
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.eq(ethers.utils.parseUnits("90"));
            // Old lender collects full principal + interest - 1% fee on interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("108.9"));
            // Lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("200"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates origination fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to a different lender, new principal covers repayment amount, with repayment fees", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("110"),
            });
            const sigProperties: SignatureProperties = {nonce: 1, maxUses: 1};
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );

            // new lender will have to pay the new principal + principal fee
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("110"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("110"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // fast forward past loan expiration
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, sigProperties, []),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const oldLenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays nothing
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(0);
            // old lender collects full repayment - 1% fee on interest - 1% fee on principal
            expect(oldLenderBalanceAfter.sub(oldLenderBalanceBefore)).to.eq(ethers.utils.parseUnits("108.9"));
            // New lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("110"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates origination fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to the same lender, borrower pays more than interest, with repayment fees", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("70"),
            });
            const sigProperties: SignatureProperties = {nonce: 1, maxUses: 1};
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );

            // borrower will have to pay difference in principal + interest
            // new lender will have to pay the new principal + principal fee
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("40"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("40"));
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("71"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("71"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // fast forward past loan expiration
            await blockchainTime.increaseTime(31536000);

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, sigProperties, []),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const oldLenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower pays interest + principal difference
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("40"));
            // old lender receives principal + interest - 1% fee on interest - 1% fee on principal
            expect(oldLenderBalanceAfter.sub(oldLenderBalanceBefore)).to.eq(ethers.utils.parseUnits("108.9"));
            // new lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("70"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates origination fees
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should rollover to a different lender, sending extra principal, with fees, and a 20% affiliate split", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                admin,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                feeController,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("200"),
            });
            const sigProperties: SignatureProperties = {nonce: 1, maxUses: 1};
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );

            // Add a 20% affiliate split
            await loanCore.connect(admin).setAffiliateSplits([affiliateCode], [{ affiliate: borrower.address, splitBps: 20_00 }])

            // borrower approves interest
            // new lender approves new principal + 1% fee on old principal
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("201"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("201"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 6);

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, sigProperties, []),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower gets principal difference - interest - origination fee
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.eq(ethers.utils.parseUnits("90"));
            // Old lender collects full principal + interest - 1% fee on interest - 1% fee on principal
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("108.9"));
            // Lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("200"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates origination fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);

            // Check affiliate split and withdraw
            expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address)).to.eq(ethers.utils.parseEther("0.22"));

            await expect(loanCore.connect(borrower).withdraw(mockERC20.address, ethers.utils.parseEther("0.22"), borrower.address))
                .to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, ethers.utils.parseEther("0.22"))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, borrower.address, ethers.utils.parseEther("0.22"));
        });

        it("should rollover to a different lender, sending extra principal, with the new lender and borrower both paying a fee, and a different affiliate on rollover", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                admin,
                newLender,
                borrowerNote,
                lenderNote,
                loanCore,
                feeController,
                blockchainTime,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = await createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("200"),
                affiliateCode: affiliateCode2
            });
            const sigProperties: SignatureProperties = {nonce: 1, maxUses: 1};
            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                EIP712_VERSION,
                sigProperties,
                "l",
            );

            // Add a 20% affiliate split for both codes
            await loanCore.connect(admin).setAffiliateSplits(
                [
                    affiliateCode,
                    affiliateCode2
                ],
                [
                    { affiliate: borrower.address, splitBps: 20_00 },
                    { affiliate: lender.address, splitBps: 20_00 }
                ])

            // borrower approves interest
            // new lender approves new principal + 1% fee on old principal
            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("201"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("201"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 6);

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, sigProperties, []),
            )
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, newLender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const ocBalanceAfter = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // Borrower gets principal difference - interest - origination fee
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.eq(ethers.utils.parseUnits("90"));
            // Old lender collects full principal + interest - 1% fee on interest - 1% fee on principal
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("108.9"));
            // Lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("200"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates origination fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("1.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);

            // Check affiliate split and withdraw
            expect(await loanCore.feesWithdrawable(mockERC20.address, lender.address)).to.eq(ethers.utils.parseEther("0.22"));

            await expect(loanCore.connect(lender).withdraw(mockERC20.address, ethers.utils.parseEther("0.22"), lender.address))
                .to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, lender.address, lender.address, ethers.utils.parseEther("0.22"))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, ethers.utils.parseEther("0.22"));
        });
    });
});
