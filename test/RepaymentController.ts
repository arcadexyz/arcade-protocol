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
    MockNoValidationOC
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { BigNumber, BigNumberish } from "ethers";
import { deploy } from "./utils/contracts";
import { approve, mint, ZERO_ADDRESS } from "./utils/erc20";
import { LoanTerms, LoanData, LoanState } from "./utils/types";
import { createLoanTermsSignature } from "./utils/eip712";

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

const createLoanTerms = (
    payableCurrency: string,
    durationSecs: BigNumberish,
    principal: BigNumberish,
    interestRate: BigNumberish,
    collateralAddress: string,
    deadline: BigNumberish,
    collateralId: BigNumberish,
    affiliateCode = ethers.constants.HashZero
): LoanTerms => {
    return {
        durationSecs,
        principal: BigNumber.from(principal),
        interestRate: BigNumber.from(interestRate),
        collateralAddress,
        collateralId,
        payableCurrency,
        deadline,
        affiliateCode
    };
};

interface LoanDef {
    loanId: BigNumberish;
    bundleId: BigNumberish;
    loanTerms: LoanTerms;
    loanData: LoanData;
}

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
    const loanTerms = createLoanTerms(
        payableCurrency,
        durationSecs,
        principal,
        interest,
        vaultFactory.address,
        deadline,
        bundleId,
        affiliateCode
    );
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

    const tx = await originationController
        .connect(lender)
        .initializeLoan(loanTerms, borrower.address, lender.address, sig, 1);
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

describe("RepaymentController", () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await loadFixture(fixture);
    });

    describe("constructor", () => {
        it("Reverts if loanCore address is not provided", async () => {
            const { feeController } = ctx;

            const RepaymentController = await ethers.getContractFactory("RepaymentController");
            await expect(RepaymentController.deploy(ZERO_ADDRESS, feeController.address)).to.be.revertedWith(
                `RC_ZeroAddress("loanCore")`
            );
        });

        it("Reverts if feeController address is not provided", async () => {
            const { loanCore } = ctx;

            const RepaymentController = await ethers.getContractFactory("RepaymentController");
            await expect(RepaymentController.deploy(loanCore.address, ZERO_ADDRESS)).to.be.revertedWith(
                `RC_ZeroAddress("feeController")`,
            );
        });

        it("Instantiates the RepaymentController", async () => {
            const { loanCore, feeController } = ctx;

            const RepaymentController = await ethers.getContractFactory("RepaymentController");
            const repaymentController = await RepaymentController.deploy(loanCore.address, feeController.address);
            await repaymentController.deployed();

            expect(repaymentController.address).to.not.be.undefined;
        });
    });

    describe("Repayment", () => {
        it("reverts if called for an invalid loanId", async () => {
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
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            const invalidId = BigNumber.from(loanId).mul(10);
            await expect(
                repaymentController.connect(borrower).repay(invalidId, total)
            ).to.be.revertedWith("RC_CannotDereference");
        });

        it("reverts if called for an non-active loan", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // borrower balance before
            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(borrowerBalanceBefore);
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
            .to.emit(mockERC20, "Transfer").withArgs(borrower.address, loanCore.address, ethers.utils.parseEther("110"));

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.be.revertedWith("RC_InvalidState");
        });

        it("repays a loan with 0 amount due", async () => {
            const { repaymentController, feeController, vaultFactory, mockERC20, loanCore, borrower, lender, admin, blockchainTime } = ctx;

            // Set up a new origination controller, that does not validate loan terms
            const mockOC = <MockNoValidationOC>await deploy("MockNoValidationOC", admin, [loanCore.address, feeController.address]);
            await mockOC.setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
            await mockOC.setAllowedCollateralAddresses([vaultFactory.address], [true]);

            await loanCore.grantRole(
                ORIGINATOR_ROLE,
                mockOC.address,
            );

            const bundleId = await initializeBundle(vaultFactory, borrower);
            await vaultFactory.connect(borrower).approve(loanCore.address, bundleId);

            const loanTerms = createLoanTerms(
                mockERC20.address,
                31536000,
                0, // 0 principal
                1000,
                vaultFactory.address,
                1754884800,
                bundleId,
                ethers.constants.HashZero
            );

            const sig = await createLoanTermsSignature(
                mockOC.address,
                "OriginationController",
                loanTerms,
                borrower,
                "3",
                1,
                "b",
            );

            const tx = await mockOC
                .connect(lender)
                .initializeLoan(loanTerms, borrower.address, lender.address, sig, 1);
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

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000);

            await expect(
                repaymentController.connect(borrower).repay(loanId, 0)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            const lenderBalanceAfter = await mockERC20.balanceOf(lender.address);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(0);
        });

        it("Repay interest and principal. 100 ETH principal, 10% interest rate.", async () => {
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
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
        });

        it("Repay interest and principal. 10 ETH principal, 7.5% interest rate.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("10"), // principal
                750, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("10.75");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
        });

        it("Repay interest and principal. 25 ETH principal, 2.5% interest rate.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("25"), // principal
                250, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("25.625");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
        });

        it("Third party repayment, interest and principal. 100 ETH principal, 10% interest rate.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, other, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");

            // mint 3rd party account exactly enough to repay loan
            await mint(mockERC20, other, total);
            await mockERC20.connect(other).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(other).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            expect(await mockERC20.balanceOf(other.address)).to.eq(0);
        });

        it("Repay interest and principal. 25 ETH principal, 2.5% interest rate. Borrower tries to repay with insufficient balance. Loan stays open.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("25"), // principal
                250, // interest
                1754884800, // deadline
            );

            // total repayment amount less than 25.625ETH
            const total = ethers.utils.parseEther("25.624");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(repaymentController.connect(borrower).repay(loanId, total))
                .to.emit(loanCore, "LoanPayment").withArgs(loanId);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            const loanData: LoanState = (await loanCore.getLoan(loanId)).state;

            expect(loanData).to.eq(1);
        });

        it("Repay interest and principal. 25 ETH principal, 2.5% interest rate. Borrower tries to repay with insufficient allowance. Should revert.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("25"), // principal
                250, // interest
                1754884800, // deadline
            );

            // total repayment amount less than 25.625ETH
            const total = ethers.utils.parseEther("25.625");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 2);

            await expect(repaymentController.connect(borrower).repay(loanId, total)).to.be.revertedWith(
                "ERC20: transfer amount exceeds allowance",
            );
        });

        it("Repay interest and principal. 9999 Wei principal, 2.5% interest rate. Should revert on initialization.", async () => {
            const { mockERC20 } = ctx;

            await expect(
                initializeLoan(
                    ctx,
                    mockERC20.address,
                    BigNumber.from(31536000), // durationSecs
                    ethers.utils.parseEther(".000000000000009999"), // principal
                    250, // interest
                    1754884800, // deadline
                ),
            ).to.be.revertedWith("OC_PrincipalTooLow");
        });

        it("Repay interest and principal. 1000000 Wei principal, 2.5% interest rate.", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, blockchainTime } = ctx;

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther(".00000000001"), // principal
                250, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther(".000000000010250");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            await mint(mockERC20, borrower, ethers.utils.parseEther("1"));
            await mockERC20.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("1"));
            await expect(repaymentController.connect(borrower).repay(loanId, ethers.utils.parseEther("1")))
                .to.be.revertedWith("RC_InvalidState");
        });

        it("100 ETH principal, 10% interest rate, 20% fee on interest", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, feeController, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("2"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("108"));
        });

        it("100 ETH principal, 10% interest rate, 20% fee on interest, 50% affiliate fee split (only on repay)", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, admin, feeController, blockchainTime } = ctx;

            const code = ethers.utils.id("FOO");

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
                code
            );

            // Register affiliate
            await loanCore.connect(admin).setAffiliateSplits([code], [{ affiliate: borrower.address, splitBps: 50_00 }])

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("2"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("108"));

            expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address)).to.eq(ethers.utils.parseEther("1"));

            await expect(loanCore.connect(borrower).withdraw(mockERC20.address, ethers.utils.parseEther("0.5"), borrower.address))
                .to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, ethers.utils.parseEther("0.5"))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, borrower.address, ethers.utils.parseEther("0.5"));
        });

        it("100 ETH principal, 10% interest rate, 20% fee on interest, 2% on principal", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, feeController, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);
            await feeController.setLendingFee(await feeController.FL_07(), 2_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("4"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("106"));
        });

        it("100 ETH principal, 10% interest rate, 5% on principal, none on interest", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, feeController, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_07(), 5_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("5"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("105"));
        });
    });

    describe("Two-Step Repayment", () => {
        it("100 ETH principal, 10% interest, borrower force repays (20% interest, 2% principal fee on lender)", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, feeController, lenderNote, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);
            await feeController.setLendingFee(await feeController.FL_07(), 2_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            // Should have 4 for fees, 106 for lender
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("110"));

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect(noteReceipt.amount).to.eq(ethers.utils.parseEther("106"));
            expect(await lenderNote.ownerOf(loanId)).to.eq(lender.address);

            await expect(
                repaymentController.connect(lender).redeemNote(loanId, lender.address)
            ).to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, lender.address, loanId, ethers.utils.parseEther("106"))
                .to.emit(lenderNote, "Transfer")
                .withArgs(lender.address, ethers.constants.AddressZero, loanId);
        });

        it("forceRepay works even if lender cannot receive tokens", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, other, feeController, lenderNote, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);
            await feeController.setLendingFee(await feeController.FL_07(), 2_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // Add lender to the mockERC20 blacklist
            await mockERC20.setBlacklisted(lender.address, true);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            // Repay should fail bc of blacklist
            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.be.revertedWith("Blacklisted");

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            // Should have 4 for fees, 106 for lender
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("110"));

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect(noteReceipt.amount).to.eq(ethers.utils.parseEther("106"));
            expect(await lenderNote.ownerOf(loanId)).to.eq(lender.address);

            // Transfer note to a different user, who can redeem
            await lenderNote.connect(lender).transferFrom(lender.address, other.address, loanId);

            await expect(
                repaymentController.connect(other).redeemNote(loanId, other.address)
            ).to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, other.address, other.address, loanId, ethers.utils.parseEther("106"))
                .to.emit(lenderNote, "Transfer")
                .withArgs(other.address, ethers.constants.AddressZero, loanId);
        });

        it("if lender blacklisted, redeemNote can send to 3rd party", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, other, feeController, lenderNote, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);
            await feeController.setLendingFee(await feeController.FL_07(), 2_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // Add lender to the mockERC20 blacklist
            await mockERC20.setBlacklisted(lender.address, true);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            // Repay should fail bc of blacklist
            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.be.revertedWith("Blacklisted");

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            // Should have 4 for fees, 106 for lender
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("110"));

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect(noteReceipt.amount).to.eq(ethers.utils.parseEther("106"));
            expect(await lenderNote.ownerOf(loanId)).to.eq(lender.address);

            // Call from lender, but send to other address
            await expect(
                repaymentController.connect(lender).redeemNote(loanId, other.address)
            ).to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, other.address, loanId, ethers.utils.parseEther("106"))
                .to.emit(lenderNote, "Transfer")
                .withArgs(lender.address, ethers.constants.AddressZero, loanId);
        });

        it("lender cannot reclaim funds without holding note", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, other, feeController, lenderNote, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);
            await feeController.setLendingFee(await feeController.FL_07(), 2_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // Add lender to the mockERC20 blacklist
            await mockERC20.setBlacklisted(lender.address, true);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            // Repay should fail bc of blacklist
            await expect(
                repaymentController.connect(borrower).repay(loanId, total)
            ).to.be.revertedWith("Blacklisted");

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            // Should have 4 for fees, 106 for lender
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("110"));

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect(noteReceipt.amount).to.eq(ethers.utils.parseEther("106"));
            expect(await lenderNote.ownerOf(loanId)).to.eq(lender.address);

            // Transfer note to a different user
            await lenderNote.connect(lender).transferFrom(lender.address, other.address, loanId);

            // Lender no longer owns note
            await expect(
                repaymentController.connect(lender).redeemNote(loanId, lender.address)
            ).to.be.revertedWith("RC_OnlyLender");
        });

        it("lender cannot redeem same note twice", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, feeController, lenderNote, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);
            await feeController.setLendingFee(await feeController.FL_07(), 2_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            // Should have 4 for fees, 106 for lender
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("110"));

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect(noteReceipt.amount).to.eq(ethers.utils.parseEther("106"));
            expect(await lenderNote.ownerOf(loanId)).to.eq(lender.address);

            await expect(
                repaymentController.connect(lender).redeemNote(loanId, lender.address)
            ).to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, lender.address, loanId, ethers.utils.parseEther("106"))
                .to.emit(lenderNote, "Transfer")
                .withArgs(lender.address, ethers.constants.AddressZero, loanId);

            // Trying again should fail, loan is already closed
            // Lender no longer owns note since burned
            await expect(
                repaymentController.connect(lender).redeemNote(loanId, lender.address)
            ).to.be.revertedWith("ERC721: owner query for nonexistent token");
        });

        it("lender cannot redeem an active loan", async () => {
            const { mockERC20, repaymentController, lender } = ctx;

            const { loanId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // Should fail, since loan has not been repaid
            await expect(
                repaymentController.connect(lender).redeemNote(loanId, lender.address)
            ).to.be.revertedWith("RC_InvalidState");
        });

        it("reverts if redeemNote() is called to address zero", async () => {
            const { mockERC20, repaymentController, lender } = ctx;

            const { loanId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // Should fail, cannot send to address zero and loan not repaid
            await expect(
                repaymentController.connect(lender).redeemNote(loanId, ethers.constants.AddressZero),
            ).to.be.revertedWith(`RC_ZeroAddress("to")`);
        });

        it("100 ETH principal, 10% interest, borrower force repays (20% interest, 2% principal, 10% redeem fee on lender)", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, feeController, lenderNote, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);
            await feeController.setLendingFee(await feeController.FL_07(), 2_00);
            await feeController.setLendingFee(await feeController.FL_08(), 10_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            // Should have 4 for fees, 106 for lender
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("110"));

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect(noteReceipt.amount).to.eq(ethers.utils.parseEther("106"));
            expect(await lenderNote.ownerOf(loanId)).to.eq(lender.address);

            await expect(
                repaymentController.connect(lender).redeemNote(loanId, lender.address)
            ).to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, lender.address, loanId, ethers.utils.parseEther("95.4"))
                .to.emit(lenderNote, "Transfer")
                .withArgs(lender.address, ethers.constants.AddressZero, loanId);

            // Now, lender withdrew, and more fees available - lender gets 106 - 10.6 = 95.4
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("14.6"));
            expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("95.4"));
        });

        it("100 ETH principal, 10% interest, lender fees change during loan", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, other, feeController, lenderNote, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);
            await feeController.setLendingFee(await feeController.FL_07(), 2_00);
            await feeController.setLendingFee(await feeController.FL_08(), 10_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // lender fees change during loan
            await feeController.setLendingFee(await feeController.FL_06(), 21_00);
            await feeController.setLendingFee(await feeController.FL_07(), 3_00);

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            // Add lender to the mockERC20 blacklist
            await mockERC20.setBlacklisted(lender.address, true);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            // Should have 4 for fees, 106 for lender
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("110"));

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect(noteReceipt.amount).to.eq(ethers.utils.parseEther("106"));
            expect(await lenderNote.ownerOf(loanId)).to.eq(lender.address);

            await expect(
                repaymentController.connect(lender).redeemNote(loanId, other.address)
            ).to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, other.address, loanId, ethers.utils.parseEther("95.4"))
                .to.emit(lenderNote, "Transfer")
                .withArgs(lender.address, ethers.constants.AddressZero, loanId);

            // Now, lender withdrew, and more fees available - lender gets 106 - 10.6 = 95.4
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("14.6"));
            expect(await mockERC20.balanceOf(other.address)).to.eq(ethers.utils.parseEther("95.4"));
        });

        it("100 ETH principal, 10% interest, lender fees and redeem note fee change during loan", async () => {
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, other, feeController, lenderNote, blockchainTime } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_06(), 20_00);
            await feeController.setLendingFee(await feeController.FL_07(), 2_00);
            await feeController.setLendingFee(await feeController.FL_08(), 10_00);

            const { loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(31536000), // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
            );

            // lender fees change during loan
            await feeController.setLendingFee(await feeController.FL_06(), 21_00);
            await feeController.setLendingFee(await feeController.FL_07(), 3_00);
            await feeController.setLendingFee(await feeController.FL_08(), 9_00);

            // total repayment amount
            const total = ethers.utils.parseEther("110");
            const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
            // mint borrower exactly enough to repay loan
            await mint(mockERC20, borrower, repayAdditionalAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, total);

            // Add lender to the mockERC20 blacklist
            await mockERC20.setBlacklisted(lender.address, true);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

            // go to 1 block before loan expires
            await blockchainTime.increaseTime(31536000 - 3);

            await expect(
                repaymentController.connect(borrower).forceRepay(loanId, total)
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

            // Should have 4 for fees, 106 for lender
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("110"));

            const noteReceipt = await loanCore.noteReceipts(loanId);
            expect(noteReceipt.token).to.eq(mockERC20.address);
            expect(noteReceipt.amount).to.eq(ethers.utils.parseEther("106"));
            expect(await lenderNote.ownerOf(loanId)).to.eq(lender.address);

            await expect(
                repaymentController.connect(lender).redeemNote(loanId, other.address)
            ).to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, other.address, loanId, ethers.utils.parseEther("96.46"))
                .to.emit(lenderNote, "Transfer")
                .withArgs(lender.address, ethers.constants.AddressZero, loanId);

            // Now, lender withdrew, and more fees available - lender gets 106 - 13.54 = 96.46
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("13.54"));
            expect(await mockERC20.balanceOf(other.address)).to.eq(ethers.utils.parseEther("96.46"));
        });
    });

    describe("Defaults", () => {
        let loanId: BigNumberish;
        let bundleId: BigNumberish;
        const duration = 31536000;
        const affiliateCode = ethers.utils.id("FOO");

        it("100 ETH principal, 10% interest, borrower defaults and lender claims (zero fee)", async () => {
            const { lender, repaymentController, loanCore, vaultFactory, mockERC20, blockchainTime } = ctx;

            ({ loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                duration, // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
                affiliateCode
            ));

            // Wind to expiry to include grace period
            // go to 1 block before grace period ends. In the next block, the loan will be claimable
            await blockchainTime.increaseTime(31536000 + 600);

            await expect(repaymentController.connect(lender).claim(loanId))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(lender.address);
        });

        it("100 ETH principal, 10% interest, borrower defaults and lender claims (5% fee)", async () => {
            const { lender, repaymentController, loanCore, vaultFactory, mockERC20, feeController, blockchainTime } = ctx;

            // Set 5% claim fee (assessed on total owed)
            await feeController.setLendingFee(await feeController.FL_05(), 5_00);

            ({ loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                duration, // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
                affiliateCode
            ));

            // Wind to expiry to include grace period
            // go to 1 block before grace period ends. In the next block, the loan will be claimable
            await blockchainTime.increaseTime(31536000 + 600);

            // Mint to lender
            const fee = ethers.utils.parseEther("5.5");
            await mint(mockERC20, lender, fee);
            await approve(mockERC20, lender, loanCore.address, fee);

            expect(await mockERC20.balanceOf(lender.address)).to.eq(fee);

            await expect(repaymentController.connect(lender).claim(loanId))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(lender.address);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(fee);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);
        });

        it("100 ETH principal, 10% interest, borrower defaults and lender claims (5% fee, 10% affiliate split)", async () => {
            const { lender, borrower, admin, repaymentController, loanCore, vaultFactory, feeController, mockERC20, blockchainTime } = ctx;

            // Set 5% claim fee (assessed on total owed)
            await feeController.setLendingFee(await feeController.FL_05(), 5_00);

            ({ loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                duration, // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
                affiliateCode
            ));

            // Register affiliate
            await loanCore.connect(admin).setAffiliateSplits([affiliateCode], [{ affiliate: borrower.address, splitBps: 10_00 }])

            // Mint to lender
            const fee = ethers.utils.parseEther("5.5");
            await mint(mockERC20, lender, fee);
            await approve(mockERC20, lender, loanCore.address, fee);

            expect(await mockERC20.balanceOf(lender.address)).to.eq(fee);

            // Wind to expiry to include grace period
            // go to 1 block before grace period ends. In the next block, the loan will be claimable
            await blockchainTime.increaseTime(31536000 - 3 + 600);

            await expect(repaymentController.connect(lender).claim(loanId))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(lender.address);
            expect(await mockERC20.balanceOf(loanCore.address)).to.eq(fee);
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);

            expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address)).to.eq(fee.div(10));

            await expect(loanCore.connect(borrower).withdraw(mockERC20.address, fee.div(10), borrower.address))
                .to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, fee.div(10))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, borrower.address, fee.div(10));
        });

        it("100 ETH principal, 10% interest, lender cannot claim before expiry, reverts", async () => {
            const { repaymentController, lender, mockERC20, blockchainTime } = ctx;

            ({ loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                duration, // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
                affiliateCode
            ));

            // Wind to expiry to include grace period
            // go to 10 blocks before grace period ends. Loan is not claimable yet
            await blockchainTime.increaseTime(31536000 + 590);

            await expect(repaymentController.connect(lender).claim(loanId))
                .to.be.revertedWith("LC_NotExpired");
        });

        it("100 ETH principal, 10% interest, borrower defaults, non-lender, reverts", async () => {
            const { repaymentController, borrower, mockERC20, blockchainTime } = ctx;

            ({ loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                duration, // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
                affiliateCode
            ));

            // Wind to expiry to include grace period
            // go to 1 block before grace period ends. In the next block, the loan will be claimable
            await blockchainTime.increaseTime(31536000 + 600);

            await expect(repaymentController.connect(borrower).claim(loanId))
                .to.be.revertedWith("RC_OnlyLender");
        });

        it("100 ETH principal, 10% interest, borrower defaults, lender cannot pay claim fee, reverts", async () => {
            const { lender, repaymentController, mockERC20, feeController, blockchainTime } = ctx;

            // Set 5% claim fee (assessed on total owed)
            await feeController.setLendingFee(await feeController.FL_05(), 5_00);

            ({ loanId, bundleId } = await initializeLoan(
                ctx,
                mockERC20.address,
                duration, // durationSecs
                ethers.utils.parseEther("100"), // principal
                1000, // interest
                1754884800, // deadline
                affiliateCode
            ));

            // Wind to expiry to include grace period
            // go to 1 block before grace period ends. In the next block, the loan will be claimable
            await blockchainTime.increaseTime(31536000 + 600);

            // Lender has no coins
            expect(await mockERC20.balanceOf(lender.address)).to.eq(0);

            await expect(repaymentController.connect(lender).claim(loanId))
                .to.be.revertedWith("ERC20: transfer amount exceeds balance");
        });
    });
});
