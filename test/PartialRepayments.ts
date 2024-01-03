import { expect } from "chai";
import hre, { ethers, waffle } from "hardhat";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import {
    OriginationController,
    PromissoryNote,
    RepaymentController,
    LoanCore,
    MockERC20,
    AssetVault,
    CallWhitelist,
    VaultFactory,
    FeeController,
    BaseURIDescriptor,
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { BigNumber, BigNumberish } from "ethers";
import { deploy } from "./utils/contracts";
import { approve, mint } from "./utils/erc20";
import { LoanTerms, LoanData, Borrower } from "./utils/types";
import { createEmptyPermitSignature, createLoanTermsSignature } from "./utils/eip712";

import {
    ORIGINATOR_ROLE,
    REPAYER_ROLE,
    AFFILIATE_MANAGER_ROLE,
    BASE_URI,
    MIN_LOAN_PRINCIPAL
} from "./utils/constants";

interface TestContext {
    loanCore: LoanCore;
    mockERC20: MockERC20;
    borrowerNote: PromissoryNote;
    lenderNote: PromissoryNote;
    vaultFactory: VaultFactory;
    feeController: FeeController;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    borrower: SignerWithAddress;
    lender: SignerWithAddress;
    admin: SignerWithAddress;
    other: SignerWithAddress;
    currentTimestamp: number;
    blockchainTime: BlockchainTime;
}

interface LoanDef {
    loanId: BigNumberish;
    bundleId: BigNumberish;
    loanTerms: LoanTerms;
    loanData: LoanData;
}

/**
 * Sets up a test asset vault for the user passed as an arg
 */
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

/**
 * Sets up a test ctx, deploying new contracts and returning them for use in a test
 */
const fixture = async (): Promise<TestContext> => {
    const blockchainTime = new BlockchainTime();
    const currentTimestamp = await blockchainTime.secondsFromNow(0);

    const signers: SignerWithAddress[] = await ethers.getSigners();
    const [borrower, lender, admin, other] = signers;

    const whitelist = <CallWhitelist>await deploy("CallWhitelist", admin, []);
    const vaultTemplate = <AssetVault>await deploy("AssetVault", admin, []);
    const feeController = <FeeController>await deploy("FeeController", admin, []);
    const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI])
    const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address])

    const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN", descriptor.address]);
    const lenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN", descriptor.address]);

    const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [borrowerNote.address, lenderNote.address]);

    // Grant correct permissions for promissory note
    for (const note of [borrowerNote, lenderNote]) {
        await note.connect(admin).initialize(loanCore.address);
    }

    const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);

    const originationController = <OriginationController>await deploy(
        "OriginationController", signers[0], [loanCore.address, feeController.address]
    )
    await originationController.deployed();

    // admin whitelists MockERC20 on OriginationController
    await originationController.setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    // verify the currency is whitelisted
    const isWhitelisted = await originationController.allowedCurrencies(mockERC20.address);
    expect(isWhitelisted.isAllowed).to.be.true;
    expect(isWhitelisted.minPrincipal).to.eq(MIN_LOAN_PRINCIPAL);

    // admin whitelists MockERC721 and vaultFactory on OriginationController
    await originationController.setAllowedCollateralAddresses([vaultFactory.address], [true]);
    // verify the collateral is whitelisted
    const isVaultFactoryWhitelisted = await originationController.allowedCollateral(vaultFactory.address);
    expect(isVaultFactoryWhitelisted).to.be.true;

    const repaymentController = <RepaymentController>await deploy("RepaymentController", admin, [loanCore.address, feeController.address]);

    await repaymentController.deployed();
    const updateRepaymentControllerPermissions = await loanCore.grantRole(REPAYER_ROLE, repaymentController.address);
    await updateRepaymentControllerPermissions.wait();

    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, admin.address);

    return {
        loanCore,
        borrowerNote,
        lenderNote,
        feeController,
        repaymentController,
        originationController,
        mockERC20,
        vaultFactory,
        borrower,
        lender,
        admin,
        other,
        currentTimestamp,
        blockchainTime,
    };
};

const initializeLoan = async (
    ctx: TestContext,
    payableCurrency: string,
    durationSecs: BigNumberish,
    principal: BigNumberish,
    interest: BigNumberish,
    deadline: BigNumberish,
    affiliateCode = ethers.constants.HashZero
): Promise<LoanDef> => {
    const { originationController, mockERC20, vaultFactory, loanCore, lender, borrower } = ctx;
    const bundleId = await initializeBundle(vaultFactory, borrower);
    const loanTerms: LoanTerms = {
        interestRate: BigNumber.from(interest),
        durationSecs: durationSecs,
        collateralAddress: vaultFactory.address,
        deadline: deadline,
        payableCurrency: payableCurrency,
        principal: BigNumber.from(principal),
        collateralId: bundleId,
        affiliateCode: affiliateCode
    }
    await mint(mockERC20, lender, loanTerms.principal);

    // borrower signs loan terms
    const sig = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        loanTerms,
        borrower,
        "3",
        1,
        "b",
    );

    // lender accepts loan terms
    await approve(mockERC20, lender, originationController.address, loanTerms.principal);
    await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

    const emptyPermitSig = createEmptyPermitSignature();
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
            1,
            [],
            emptyPermitSig,
            0
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

describe("PartialRepayments", () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await loadFixture(fixture);
    });

    describe("Multiple repayments", () => {
        it("3 repayments. 120 ETH principal, 10% APR, 1 yr", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("120"), // principal
                1000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to 30 days into loan
            await blockchainTime.increaseTime(2592000 - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther(".986301369863013698")
            expect(grossInterest1).to.gt(ethers.utils.parseEther(".9863")).and.lt(ethers.utils.parseEther(".9864"));

            // borrower sends 10ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("10").add(grossInterest1);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 10 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).repay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(1);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("110"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("110"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("10").add(grossInterest1));

            // ------------------ Second Repayment ------------------
            // get updated loan data
            const loanData2: LoanData = await loanCore.getLoan(loanId);

            // increase time to 60 days into loan
            await blockchainTime.increaseTime(2592000 - 3);

            // calculate interest payment
            const t2 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest2: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData2.balance,
                loanData2.terms.interestRate,
                loanData2.terms.durationSecs,
                loanData2.startDate,
                loanData2.lastAccrualTimestamp,
                t2
            );
            // expecting: (ethers.utils.parseEther(".904109589041095890")
            expect(grossInterest2).to.gt(ethers.utils.parseEther(".9041")).and.lt(ethers.utils.parseEther(".9042"));

            // borrower sends 10ETH to pay the principal
            const repayAmount2 = ethers.utils.parseEther("10").add(grossInterest2);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest2);
            // approve loan core to spend interest + 10 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount2);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).repay(loanId, repayAmount2)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData3: LoanData = await loanCore.getLoan(loanId);
            expect(loadData3.state).to.eq(1);
            expect(loadData3.lastAccrualTimestamp).to.eq(t2);
            expect(loadData3.balance).to.eq(ethers.utils.parseEther("100"));
            expect(loadData3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2));

            // check effective interest rate
            const effectiveInterestRate2 = await loanCore.getCloseEffectiveInterestRate(loanId);
            // expecting 958
            expect(effectiveInterestRate2).to.be.gt(948).and.lt(968);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("100"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("20").add(grossInterest1).add(grossInterest2));

            // ------------------ Third Repayment ------------------
            // get updated loan data
            const loanData3: LoanData = await loanCore.getLoan(loanId);

            // increase time to 90 days into loan
            await blockchainTime.increaseTime(2592000 - 3);

            // calculate interest payment
            const t3 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest3: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData3.balance,
                loanData3.terms.interestRate,
                loanData3.terms.durationSecs,
                loanData3.startDate,
                loanData3.lastAccrualTimestamp,
                t3
            );
            // expecting: ethers.utils.parseEther(".821917808219178082")
            expect(grossInterest3).to.gt(ethers.utils.parseEther(".8219")).and.lt(ethers.utils.parseEther(".8220"));

            // borrower sends 100ETH to pay the principal
            const repayAmount3 = ethers.utils.parseEther("100").add(grossInterest3);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest3);
            // approve loan core to spend interest + 100 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount3);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).repay(loanId, repayAmount3)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadDataAfterRepay3: LoanData = await loanCore.getLoan(loanId);
            expect(loadDataAfterRepay3.state).to.eq(2);
            expect(loadDataAfterRepay3.lastAccrualTimestamp).to.eq(t3);
            expect(loadDataAfterRepay3.balance).to.eq(0);
            expect(loadDataAfterRepay3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2).add(grossInterest3));

            // check effective interest rate
            const effectiveInterestRate3 = await loanCore.getCloseEffectiveInterestRate(loanId);
            // expecting 916
            expect(effectiveInterestRate3).to.be.gt(906).and.lt(926);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("120").add(grossInterest1).add(grossInterest2).add(grossInterest3));
        });

        it("2 repayments. 100 ETH principal, 20% APR, 1 yr", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("100"), // principal
                2000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to half the duration
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther("10")
            expect(grossInterest1).to.gt(ethers.utils.parseEther("9.9999")).and.lt(ethers.utils.parseEther("10.0001"));

            // borrower sends 50ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("50").add(grossInterest1);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).repay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(1);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("50"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("50"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("50").add(grossInterest1));

            // ------------------ Second Repayment ------------------
            // get updated loan data
            const loanData2: LoanData = await loanCore.getLoan(loanId);

            // increase time to end of loan
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            // calculate interest payment
            const t2 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest2: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData2.balance,
                loanData2.terms.interestRate,
                loanData2.terms.durationSecs,
                loanData2.startDate,
                loanData2.lastAccrualTimestamp,
                t2
            );
            // expecting: ethers.utils.parseEther("5")
            expect(grossInterest2).to.gt(ethers.utils.parseEther("4.9999")).and.lt(ethers.utils.parseEther("5.0001"));

            // borrower sends 50ETH to pay the principal
            const repayAmount2 = ethers.utils.parseEther("50").add(grossInterest2);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest2);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount2);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).repay(loanId, repayAmount2)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadData3: LoanData = await loanCore.getLoan(loanId);
            expect(loadData3.state).to.eq(2);
            expect(loadData3.lastAccrualTimestamp).to.eq(t2);
            expect(loadData3.balance).to.eq(0);
            expect(loadData3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2));

            // check effective interest rate
            const effectiveInterestRate = await repaymentController.effectiveInterestRate(
                loadData3.interestAmountPaid,
                BigNumber.from(loadData3.lastAccrualTimestamp).sub(BigNumber.from(loanData.startDate)),
                loanData.terms.principal
            );
            // expecting 1500
            expect(effectiveInterestRate).to.be.gt(1490).and.lt(1510);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("100").add(grossInterest1).add(grossInterest2));
        });

        it("2 repayments. 100 ETH principal, 20% APR, 30 days", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(2592000), // durationSecs (3600*24*30)
                ethers.utils.parseEther("100"), // principal
                2000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to 15 days into loan
            await blockchainTime.increaseTime((2592000 / 2) - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther(".821917808219178082")
            expect(grossInterest1).to.gt(ethers.utils.parseEther(".8219")).and.lt(ethers.utils.parseEther(".8220"));

            // borrower sends 50ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("50").add(grossInterest1);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).repay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(1);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("50"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("50"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("50").add(grossInterest1));

            // ------------------ Second Repayment ------------------

            // get updated loan data
            const loanData2: LoanData = await loanCore.getLoan(loanId);

            // increase time to 22.5 days into loan
            await blockchainTime.increaseTime((2592000 / 4) - 3);

            // calculate interest payment
            const t2 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest2: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData2.balance,
                loanData2.terms.interestRate,
                loanData2.terms.durationSecs,
                loanData2.startDate,
                loanData2.lastAccrualTimestamp,
                t2
            );
            // expecting: ethers.utils.parseEther(".205479452054794520")
            expect(grossInterest2).to.gt(ethers.utils.parseEther(".2054")).and.lt(ethers.utils.parseEther(".2055"));

            // borrower sends 50ETH to pay the principal
            const repayAmount2 = ethers.utils.parseEther("50").add(grossInterest2);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest2);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount2);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).repay(loanId, repayAmount2)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadData3: LoanData = await loanCore.getLoan(loanId);
            expect(loadData3.state).to.eq(2);
            expect(loadData3.lastAccrualTimestamp).to.eq(t2);
            expect(loadData3.balance).to.eq(0);
            expect(loadData3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2));

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("100").add(grossInterest1).add(grossInterest2));

            // check effective interest rate
            const effectiveInterestRate = await loanCore.getCloseEffectiveInterestRate(loanId);
            // expecting 1666
            expect(effectiveInterestRate).to.be.gt(1656).and.lt(1676);
        });

        it("repayment amount must be greater than interest due", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("120"), // principal
                1000, // interest
                Date.now() + 604800, // deadline
            );

            // increase time to 30 days into loan
            await blockchainTime.increaseTime(2592000 - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );

            // borrower sends less than interest due
            const repayAmount1 = grossInterest1.sub(10);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 10 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).repay(loanId, repayAmount1)
            ).to.be.revertedWith(`RC_InvalidRepayment(${repayAmount1.toString()}, ${grossInterest1.toString()})`);
            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(1);
            expect(loadData1.lastAccrualTimestamp).to.eq(loanData.startDate);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("120"));
            expect(loadData1.interestAmountPaid).to.eq(0);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);
        });

        it("borrower sends extra principal", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("100"), // principal
                2000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to half the duration
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: (ethers.utils.parseEther("10")
            expect(grossInterest1).to.gt(ethers.utils.parseEther("9.9999")).and.lt(ethers.utils.parseEther("10.0001"));

            // borrower sends 101ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("101").add(grossInterest1);

            // mint borrower interest and extra principal
            await mint(mockERC20, borrower, grossInterest1.add(ethers.utils.parseEther("1")));
            // approve loan core to spend interest + 101 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).repay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(2);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("0"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("1"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("100").add(grossInterest1));
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(0);
        });

        it("getCloseEffectiveInterestRate on invalid tokenId", async () => {
            const { loanCore } = ctx;

            // invalid tokenId
            await expect(
                loanCore.getCloseEffectiveInterestRate(1234)
            ).to.be.revertedWith("LC_InvalidState");
        });
    });

    describe("Multiple force repayments", () => {
        it("3 force repayments. 120 ETH principal, 10% APR, 1 yr", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("120"), // principal
                1000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to 30 days into loan
            await blockchainTime.increaseTime(2592000 - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther(".986301369863013698")
            expect(grossInterest1).to.gt(ethers.utils.parseEther(".9863")).and.lt(ethers.utils.parseEther(".9864"));

            // borrower sends 10ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("10").add(grossInterest1);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 10 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(1);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("110"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("110"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);

            // ------------------ Second Repayment ------------------
            // get updated loan data
            const loanData2: LoanData = await loanCore.getLoan(loanId);

            // increase time to 60 days into loan
            await blockchainTime.increaseTime(2592000 - 3);

            // calculate interest payment
            const t2 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest2: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData2.balance,
                loanData2.terms.interestRate,
                loanData2.terms.durationSecs,
                loanData2.startDate,
                loanData2.lastAccrualTimestamp,
                t2
            );
            // expecting: ethers.utils.parseEther(".904109589041095890")
            expect(grossInterest2).to.gt(ethers.utils.parseEther(".9041")).and.lt(ethers.utils.parseEther(".9042"));

            // borrower sends 10ETH to pay the principal
            const repayAmount2 = ethers.utils.parseEther("10").add(grossInterest2);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest2);
            // approve loan core to spend interest + 10 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount2);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount2)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData3: LoanData = await loanCore.getLoan(loanId);
            expect(loadData3.state).to.eq(1);
            expect(loadData3.lastAccrualTimestamp).to.eq(t2);
            expect(loadData3.balance).to.eq(ethers.utils.parseEther("100"));
            expect(loadData3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2));

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("100"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);

            // ------------------ Third Repayment ------------------
            // get updated loan data
            const loanData3: LoanData = await loanCore.getLoan(loanId);

            // increase time to 90 days into loan
            await blockchainTime.increaseTime(2592000 - 3);

            // calculate interest payment
            const t3 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest3: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData3.balance,
                loanData3.terms.interestRate,
                loanData3.terms.durationSecs,
                loanData3.startDate,
                loanData3.lastAccrualTimestamp,
                t3
            );
            // expecting: ethers.utils.parseEther(".821917808219178082")
            expect(grossInterest3).to.gt(ethers.utils.parseEther(".8219")).and.lt(ethers.utils.parseEther(".8220"));

            // borrower sends 100ETH to pay the principal
            const repayAmount3 = ethers.utils.parseEther("100").add(grossInterest3);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest3);
            // approve loan core to spend interest + 100 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount3);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount3)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadDataAfterRepay3: LoanData = await loanCore.getLoan(loanId);
            expect(loadDataAfterRepay3.state).to.eq(2);
            expect(loadDataAfterRepay3.lastAccrualTimestamp).to.eq(t3);
            expect(loadDataAfterRepay3.balance).to.eq(0);
            expect(loadDataAfterRepay3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2).add(grossInterest3));

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(ethers.utils.parseEther("120").add(grossInterest1).add(grossInterest2).add(grossInterest3));
        });

        it("2 force repayments. 100 ETH principal, 20% APR, 1 yr", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("100"), // principal
                2000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to half the duration
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther("10")
            expect(grossInterest1).to.gt(ethers.utils.parseEther("9.9999")).and.lt(ethers.utils.parseEther("10.0001"));

            // borrower sends 50ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("50").add(grossInterest1);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(1);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("50"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("50"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);

            // ------------------ Second Repayment ------------------
            // get updated loan data
            const loanData2: LoanData = await loanCore.getLoan(loanId);

            // increase time to end of loan
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            // calculate interest payment
            const t2 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest2: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData2.balance,
                loanData2.terms.interestRate,
                loanData2.terms.durationSecs,
                loanData2.startDate,
                loanData2.lastAccrualTimestamp,
                t2
            );
            // expecting: ethers.utils.parseEther("5")
            expect(grossInterest2).to.gt(ethers.utils.parseEther("4.9999")).and.lt(ethers.utils.parseEther("5.0001"));

            // borrower sends 50ETH to pay the principal
            const repayAmount2 = ethers.utils.parseEther("50").add(grossInterest2);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest2);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount2);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount2)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadData3: LoanData = await loanCore.getLoan(loanId);
            expect(loadData3.state).to.eq(2);
            expect(loadData3.lastAccrualTimestamp).to.eq(t2);
            expect(loadData3.balance).to.eq(0);
            expect(loadData3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2));

            // check effective interest rate
            const effectiveInterestRate = await repaymentController.effectiveInterestRate(
                loadData3.interestAmountPaid,
                BigNumber.from(loadData3.lastAccrualTimestamp).sub(BigNumber.from(loanData.startDate)),
                loanData.terms.principal
            );
            // expecting 1500
            expect(effectiveInterestRate).to.gt(1490).and.lt(1510);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(ethers.utils.parseEther("100").add(grossInterest1).add(grossInterest2));
        });

        it("2 force repayments. 100 ETH principal, 20% APR, 30 days", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(2592000), // durationSecs (3600*24*30)
                ethers.utils.parseEther("100"), // principal
                2000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to 15 days into loan
            await blockchainTime.increaseTime((2592000 / 2) - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther(".821917808219178082")
            expect(grossInterest1).to.gt(ethers.utils.parseEther(".8219")).and.lt(ethers.utils.parseEther(".8220"));

            // borrower sends 50ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("50").add(grossInterest1);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(1);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("50"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("50"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);


            // ------------------ Second Repayment ------------------

            // get updated loan data
            const loanData2: LoanData = await loanCore.getLoan(loanId);

            // increase time to 22.5 days into loan
            await blockchainTime.increaseTime((2592000 / 4) - 3);

            // calculate interest payment
            const t2 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest2: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData2.balance,
                loanData2.terms.interestRate,
                loanData2.terms.durationSecs,
                loanData2.startDate,
                loanData2.lastAccrualTimestamp,
                t2
            );
            // expecting: ethers.utils.parseEther(".205479452054794520")
            expect(grossInterest2).to.gt(ethers.utils.parseEther(".2054")).and.lt(ethers.utils.parseEther(".2055"));

            // borrower sends 50ETH to pay the principal
            const repayAmount2 = ethers.utils.parseEther("50").add(grossInterest2);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest2);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount2);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount2)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadData3: LoanData = await loanCore.getLoan(loanId);
            expect(loadData3.state).to.eq(2);
            expect(loadData3.lastAccrualTimestamp).to.eq(t2);
            expect(loadData3.balance).to.eq(0);
            expect(loadData3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2));

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(ethers.utils.parseEther("100").add(grossInterest1).add(grossInterest2));
        });

        it("borrower sends extra principal", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("100"), // principal
                2000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to half the duration
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther("10")
            expect(grossInterest1).to.gt(ethers.utils.parseEther("9.9999")).and.lt(ethers.utils.parseEther("10.0001"));

            // borrower sends 101ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("101").add(grossInterest1);

            // mint borrower interest and extra principal
            await mint(mockERC20, borrower, grossInterest1.add(ethers.utils.parseEther("1")));
            // approve loan core to spend interest + 101 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(2);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("0"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("1"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(ethers.utils.parseEther("100").add(grossInterest1));
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("100").add(grossInterest1));
        });
    });

    describe("Repay full amount", () => {
        it("Repay full. 100 ETH principal, 10% interest rate, full duration.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const timingToleranceAmount = ethers.utils.parseEther("0.1");
            const total = ethers.utils.parseEther("110").add(timingToleranceAmount); // 0.1 extra for block timing tolerance
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go over loan duration by 1 hr
            await blockchainTime.increaseTime(31536000 + 3600);

            await expect(
                repaymentController.connect(borrower).repayFull(loanId)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // expecting 0
            expect(await mockERC20.balanceOf(borrower.address)).to.gte(0).and.lte(timingToleranceAmount);

            // get effective interest rate
            const effectiveInterestRate = await loanCore.getCloseEffectiveInterestRate(loanId);
            // no tolerance here because we are well over the loan duration
            expect(effectiveInterestRate).to.eq(1000);
        });

        it("Repay full. 100 ETH principal, 10% interest rate, half duration.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const timingToleranceAmount = ethers.utils.parseEther("0.1");
            const total = ethers.utils.parseEther("105").add(timingToleranceAmount); // 0.1 extra for block timing tolerance
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before half of loan duration
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            await expect(
                repaymentController.connect(borrower).repayFull(loanId)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // expecting 0
            expect(await mockERC20.balanceOf(borrower.address)).to.gte(0).and.lte(timingToleranceAmount);

            // get effective interest rate
            const effectiveInterestRate = await loanCore.getCloseEffectiveInterestRate(loanId);
            // expecting 1000
            expect(effectiveInterestRate).to.gt(990).and.lt(1010);
        });

        it("Force repay full. 100 ETH principal, 10% interest rate, full duration.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const timingToleranceAmount = ethers.utils.parseEther("0.1");
            const total = ethers.utils.parseEther("110").add(timingToleranceAmount); // 0.1 extra for block timing tolerance
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, ethers.constants.MaxUint256)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // expecting 0
            expect(await mockERC20.balanceOf(borrower.address)).to.gte(0).and.lte(timingToleranceAmount);

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect((noteReceipt).amount).to.gte(ethers.utils.parseEther("110")).and.lt(ethers.utils.parseEther("110.1"));
        });

        it("Force repay full. 100 ETH principal, 10% interest rate, half duration.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const timingToleranceAmount = ethers.utils.parseEther("0.1");
            const total = ethers.utils.parseEther("105").add(timingToleranceAmount); // 0.1 extra for block timing tolerance
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, ethers.constants.MaxUint256)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // expecting 0
            expect(await mockERC20.balanceOf(borrower.address)).to.gte(0).and.lte(timingToleranceAmount);

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect((noteReceipt).amount).to.gte(ethers.utils.parseEther("105")).and.lt(ethers.utils.parseEther("105.1"));
        });
    });

    describe("Multiple force payments and withdrawals", () => {
        it("3 force repayments. 120 ETH principal, 10% APR, 1 yr", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("120"), // principal
                1000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to 30 days into loan
            await blockchainTime.increaseTime(2592000 - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther(".986301369863013698")
            expect(grossInterest1).to.gt(ethers.utils.parseEther(".9863")).and.lt(ethers.utils.parseEther(".9864"));

            // borrower sends 10ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("10").add(grossInterest1);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 10 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(1);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("110"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("110"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("10").add(grossInterest1));
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(ethers.utils.parseEther("10").add(grossInterest1));

            // lender redeems 10 ETH + interest
            await expect(repaymentController.connect(lender).redeemNote(loanId, lender.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address,lender.address, lender.address, loanId, ethers.utils.parseEther("10").add(grossInterest1));

            // tries to redeem again, fails no receipt balance
            await expect(repaymentController.connect(lender).redeemNote(loanId, lender.address))
                .to.be.revertedWith("LC_ZeroAmount");

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("110"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("10").add(grossInterest1));
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(0);
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(0);

            // ------------------ Second Repayment ------------------
            // get updated loan data
            const loanData2: LoanData = await loanCore.getLoan(loanId);

            // increase time to 60 days into loan
            // sub 3 for the txs after this
            // sub one for the tx before this
            await blockchainTime.increaseTime(2592000 - 3 - 1);

            // calculate interest payment
            const t2 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest2: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData2.balance,
                loanData2.terms.interestRate,
                loanData2.terms.durationSecs,
                loanData2.startDate,
                loanData2.lastAccrualTimestamp,
                t2
            );
            // expecting: ethers.utils.parseEther(".904109589041095890")
            expect(grossInterest2).to.gt(ethers.utils.parseEther(".9041")).and.lt(ethers.utils.parseEther(".9042"));

            // borrower sends 10ETH to pay the principal
            const repayAmount2 = ethers.utils.parseEther("10").add(grossInterest2);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest2);
            // approve loan core to spend interest + 10 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount2);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount2)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData3: LoanData = await loanCore.getLoan(loanId);
            expect(loadData3.state).to.eq(1);
            expect(loadData3.lastAccrualTimestamp).to.eq(t2);
            expect(loadData3.balance).to.eq(ethers.utils.parseEther("100"));
            expect(loadData3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2));

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("100"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("10").add(grossInterest1));

            // lender skips payment redemption

            // ------------------ Third Repayment ------------------
            // get updated loan data
            const loanData3: LoanData = await loanCore.getLoan(loanId);

            // increase time to 90 days into loan
            await blockchainTime.increaseTime(2592000 - 3);

            // calculate interest payment
            const t3 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest3: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData3.balance,
                loanData3.terms.interestRate,
                loanData3.terms.durationSecs,
                loanData3.startDate,
                loanData3.lastAccrualTimestamp,
                t3
            );
            // expecting: ethers.utils.parseEther(".821917808219178082")
            expect(grossInterest3).to.gt(ethers.utils.parseEther(".8219")).and.lt(ethers.utils.parseEther(".8220"));

            // borrower sends 100ETH to pay the principal
            const repayAmount3 = ethers.utils.parseEther("100").add(grossInterest3);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest3);
            // approve loan core to spend interest + 100 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount3);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount3)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadDataAfterRepay3: LoanData = await loanCore.getLoan(loanId);
            expect(loadDataAfterRepay3.state).to.eq(2);
            expect(loadDataAfterRepay3.lastAccrualTimestamp).to.eq(t3);
            expect(loadDataAfterRepay3.balance).to.eq(0);
            expect(loadDataAfterRepay3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2).add(grossInterest3));

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("10").add(grossInterest1));
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("110").add(grossInterest2).add(grossInterest3));
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(ethers.utils.parseEther("110").add(grossInterest2).add(grossInterest3));

            // lender redeems 110 ETH + interest
            await expect(repaymentController.connect(lender).redeemNote(loanId, lender.address))
            .to.emit(loanCore, "NoteRedeemed")
            .withArgs(mockERC20.address,lender.address, lender.address, loanId, ethers.utils.parseEther("110").add(grossInterest2).add(grossInterest3));

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("120").add(grossInterest1).add(grossInterest2).add(grossInterest3));
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(0);
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(0);
        });

        it("2 force repayments. 100 ETH principal, 20% APR, 1 yr", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, bundleId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("100"), // principal
                2000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to half the duration
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther("10")
            expect(grossInterest1).to.gt(ethers.utils.parseEther("9.9999")).and.lt(ethers.utils.parseEther("10.0001"));

            // borrower sends 50ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("50").add(grossInterest1);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // check loan data
            const loadData1: LoanData = await loanCore.getLoan(loanId);
            expect(loadData1.state).to.eq(1);
            expect(loadData1.lastAccrualTimestamp).to.eq(t1);
            expect(loadData1.balance).to.eq(ethers.utils.parseEther("50"));
            expect(loadData1.interestAmountPaid).to.eq(grossInterest1);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("50"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("50").add(grossInterest1));
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(ethers.utils.parseEther("50").add(grossInterest1));

            // lender redeems 50 ETH + interest
            await expect(repaymentController.connect(lender).redeemNote(loanId, lender.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address,lender.address, lender.address, loanId, ethers.utils.parseEther("50").add(grossInterest1));

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(ethers.utils.parseEther("50"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("50").add(grossInterest1));
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(0);
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(0);

            // ------------------ Second Repayment ------------------
            // get updated loan data
            const loanData2: LoanData = await loanCore.getLoan(loanId);

            // increase time to end of loan
            // sub 3 for the txs after this
            // sub one for the tx before this
            await blockchainTime.increaseTime((31536000 / 2) - 3 - 1);

            // calculate interest payment
            const t2 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest2: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData2.balance,
                loanData2.terms.interestRate,
                loanData2.terms.durationSecs,
                loanData2.startDate,
                loanData2.lastAccrualTimestamp,
                t2
            );
            // expecting: ethers.utils.parseEther("5")
            expect(grossInterest2).to.gt(ethers.utils.parseEther("4.9999")).and.lt(ethers.utils.parseEther("5.0001"));

            // borrower sends 50ETH to pay the principal
            const repayAmount2 = ethers.utils.parseEther("50").add(grossInterest2);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest2);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount2);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount2)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            // check loan data
            const loadData3: LoanData = await loanCore.getLoan(loanId);
            expect(loadData3.state).to.eq(2);
            expect(loadData3.lastAccrualTimestamp).to.eq(t2);
            expect(loadData3.balance).to.eq(0);
            expect(loadData3.interestAmountPaid).to.eq(grossInterest1.add(grossInterest2));

            // check effective interest rate
            const effectiveInterestRate = await repaymentController.effectiveInterestRate(
                loadData3.interestAmountPaid,
                BigNumber.from(loadData3.lastAccrualTimestamp).sub(BigNumber.from(loanData.startDate)),
                loanData.terms.principal
            );
            // expecting 1500
            expect(effectiveInterestRate).to.gt(1490).and.lt(1510);

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("50").add(grossInterest1));
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("50").add(grossInterest2));
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(ethers.utils.parseEther("50").add(grossInterest2));

            // lender redeems 50 ETH + interest
            await expect(repaymentController.connect(lender).redeemNote(loanId, lender.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address,lender.address, lender.address, loanId, ethers.utils.parseEther("50").add(grossInterest2));

            // check balances
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(borrower.address);
            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("100").add(grossInterest1).add(grossInterest2));
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(0);
            expect((await loanCore.noteReceipts(loanId)).amount).to.eq(0);
        });

        it("1 force repayment, then the lender claims the collateral after loan duration", async () => {
            const { repaymentController, mockERC20, loanCore, borrower, lender, blockchainTime } = ctx;

            const { loanId, loanData } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs (3600*24*365)
                ethers.utils.parseEther("100"), // principal
                2000, // interest
                Date.now() + 604800, // deadline
            );

            // ------------------ First Repayment ------------------
            // increase time to half the duration
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            // calculate interest payment
            const t1 = (await ethers.provider.getBlock("latest")).timestamp + 3;
            const grossInterest1: BigNumber = await repaymentController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                t1
            );
            // expecting: ethers.utils.parseEther("10")
            expect(grossInterest1).to.gt(ethers.utils.parseEther("9.9999")).and.lt(ethers.utils.parseEther("10.0001"));

            // borrower sends 50ETH to pay the principal
            const repayAmount1 = ethers.utils.parseEther("50").add(grossInterest1);

            // mint borrower interest
            await mint(mockERC20, borrower, grossInterest1);
            // approve loan core to spend interest + 50 ETH
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount1);

            // partial repayment
            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, repayAmount1)
            ).to.emit(loanCore, "LoanPayment").withArgs(loanId);

            // borrower defaults, fast forwards to end of loan
            await blockchainTime.increaseTime((31536000 / 2) - 3);

            // lender tries to claim collateral before withdrawing borrower payment
            await expect(
                repaymentController.connect(lender).claim(loanId)
            ).to.be.revertedWith("LC_AwaitingWithdrawal");

            // lender redeems 50 ETH + interest
            await expect(repaymentController.connect(lender).redeemNote(loanId, lender.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address,lender.address, lender.address, loanId, ethers.utils.parseEther("50").add(grossInterest1));

        });
    });
});
