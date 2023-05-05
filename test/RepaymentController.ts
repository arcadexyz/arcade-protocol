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
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { BigNumber, BigNumberish } from "ethers";
import { deploy } from "./utils/contracts";
import { approve, mint } from "./utils/erc20";
import { LoanTerms, LoanData } from "./utils/types";
import { createLoanTermsSignature } from "./utils/eip712";

const SECTION_SEPARATOR = "\n" + "=".repeat(80) + "\n";

const ORIGINATOR_ROLE = "0x59abfac6520ec36a6556b2a4dd949cc40007459bcd5cd2507f1e5cc77b6bc97e";
const REPAYER_ROLE = "0x9c60024347074fd9de2c1e36003080d22dbc76a41ef87444d21e361bcb39118e";

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
    const tx = await vaultFactory.connect(user).initializeBundle(await user.getAddress());
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
    const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address])

    const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN"]);
    const lenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN"]);

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
    const whitelistCurrency = await originationController.allowPayableCurrency([mockERC20.address]);
    await whitelistCurrency.wait();
    // verify the currency is whitelisted
    const isWhitelisted = await originationController.allowedCurrencies(mockERC20.address);
    expect(isWhitelisted).to.be.true;
    // admin whitelists VaultFactory on OriginationController
    const whitelistVaultFactory = await originationController.allowCollateralAddress([vaultFactory.address]);
    await whitelistVaultFactory.wait();
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
    durationSecs: BigNumber,
    principal: BigNumber,
    proratedInterestRate: BigNumber,
    collateralAddress: string,
    deadline: BigNumberish,
    { collateralId = 1 }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        proratedInterestRate,
        collateralAddress,
        collateralId,
        payableCurrency,
        deadline,
    };
};

interface LoanDef {
    loanId: string;
    bundleId: BigNumberish;
    loanTerms: LoanTerms;
    loanData: LoanData;
}

const initializeLoan = async (
    ctx: TestContext,
    payableCurrency: string,
    durationSecs: BigNumber,
    principal: BigNumber,
    interest: BigNumber,
    deadline: BigNumberish,
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
        { collateralId: bundleId },
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

    it("Repay interest and principal. 100 ETH principal, 10% interest rate.", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, borrower } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther("100"), // principal
            ethers.utils.parseEther("1000"), // interest
            1754884800, // deadline
        );
        // total repayment amount
        const total = ethers.utils.parseEther("110");
        const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
        // mint borrower exactly enough to repay loan
        await mint(mockERC20, borrower, repayAdditionalAmount);
        await mockERC20.connect(borrower).approve(loanCore.address, total);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        await expect(
            repaymentController.connect(borrower).repay(loanId)
        ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

        expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
    });

    it("Repay interest and principal. 10 ETH principal, 7.5% interest rate.", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, borrower } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther("10"), // principal
            ethers.utils.parseEther("750"), // interest
            1754884800, // deadline
        );

        // total repayment amount
        const total = ethers.utils.parseEther("10.75");
        const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
        // mint borrower exactly enough to repay loan
        await mint(mockERC20, borrower, repayAdditionalAmount);
        await mockERC20.connect(borrower).approve(loanCore.address, total);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        await expect(
            repaymentController.connect(borrower).repay(loanId)
        ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

        expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
    });

    it("Repay interest and principal. 25 ETH principal, 2.5% interest rate.", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, borrower } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther("25"), // principal
            ethers.utils.parseEther("250"), // interest
            1754884800, // deadline
        );

        // total repayment amount
        const total = ethers.utils.parseEther("25.625");
        const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
        // mint borrower exactly enough to repay loan
        await mint(mockERC20, borrower, repayAdditionalAmount);
        await mockERC20.connect(borrower).approve(loanCore.address, total);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        await expect(
            repaymentController.connect(borrower).repay(loanId)
        ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

        expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
    });

    it("Third party repayment, interest and principal. 100 ETH principal, 10% interest rate.", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, other } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther("100"), // principal
            ethers.utils.parseEther("1000"), // interest
            1754884800, // deadline
        );

        // total repayment amount
        const total = ethers.utils.parseEther("110");

        // mint 3rd party account exactly enough to repay loan
        await mint(mockERC20, other, total);
        await mockERC20.connect(other).approve(loanCore.address, total);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        await expect(
            repaymentController.connect(other).repay(loanId)
        ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

        expect(await mockERC20.balanceOf(other.address)).to.eq(0);
    });

    it("Repay interest and principal. 25 ETH principal, 2.5% interest rate. Borrower tries to repay with insufficient balance. Should revert.", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, borrower } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther("25"), // principal
            ethers.utils.parseEther("250"), // interest
            1754884800, // deadline
        );

        // total repayment amount less than 25.625ETH
        const total = ethers.utils.parseEther("25.624");
        const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
        // mint borrower exactly enough to repay loan
        await mint(mockERC20, borrower, repayAdditionalAmount);
        await mockERC20.connect(borrower).approve(loanCore.address, total);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        await expect(repaymentController.connect(borrower).repay(loanId)).to.be.revertedWith(
            "ERC20: transfer amount exceeds balance",
        );
    });

    it("Repay interest and principal. 25 ETH principal, 2.5% interest rate. Borrower tries to repay with insufficient allowance. Should revert.", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, borrower } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther("25"), // principal
            ethers.utils.parseEther("250"), // interest
            1754884800, // deadline
        );

        // total repayment amount less than 25.625ETH
        const total = ethers.utils.parseEther("25.625");
        const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
        // mint borrower exactly enough to repay loan
        await mint(mockERC20, borrower, repayAdditionalAmount);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        await expect(repaymentController.connect(borrower).repay(loanId)).to.be.revertedWith(
            "ERC20: transfer amount exceeds allowance",
        );
    });

    it("Repay interest and principal. 9999 Wei principal, 2.5% interest rate. Should revert on initialization.", async () => {
        const { mockERC20 } = ctx;

        await expect(
            initializeLoan(
                ctx,
                mockERC20.address,
                BigNumber.from(86400), // durationSecs
                ethers.utils.parseEther(".000000000000009999"), // principal
                ethers.utils.parseEther("250"), // interest

                1754884800, // deadline
            ),
        ).to.be.revertedWith("OC_PrincipalTooLow");
    });

    it("Repay interest and principal. 1000000 Wei principal, 2.5% interest rate.", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, borrower } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther(".00000000001"), // principal
            ethers.utils.parseEther("250"), // interest
            1754884800, // deadline
        );

        // total repayment amount less than 25.625ETH
        const total = ethers.utils.parseEther(".000000000010250");
        const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
        // mint borrower exactly enough to repay loan
        await mint(mockERC20, borrower, repayAdditionalAmount);
        await mockERC20.connect(borrower).approve(loanCore.address, total);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        await expect(
            repaymentController.connect(borrower).repay(loanId)
        ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

        expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);

        await mint(mockERC20, borrower, ethers.utils.parseEther("1"));
        await mockERC20.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("1"));
        await expect(repaymentController.connect(borrower).repay(loanId)).to.be.revertedWith("RC_InvalidState");
    });

    it("100 ETH principal, 10% interest rate, 20% fee on interest", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, feeController } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther("100"), // principal
            ethers.utils.parseEther("1000"), // interest
            1754884800, // deadline
        );

        // total repayment amount
        const total = ethers.utils.parseEther("110");
        const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
        // mint borrower exactly enough to repay loan
        await mint(mockERC20, borrower, repayAdditionalAmount);
        await mockERC20.connect(borrower).approve(loanCore.address, total);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        // Assess fee on lender
        await feeController.set(await feeController.FL_07(), 20_00);

        await expect(
            repaymentController.connect(borrower).repay(loanId)
        ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

        expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
        expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("2"));
        expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("108"));
    });

    it("100 ETH principal, 10% interest rate, 20% fee on interest, 2% on principal", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, feeController } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther("100"), // principal
            ethers.utils.parseEther("1000"), // interest
            1754884800, // deadline
        );

        // total repayment amount
        const total = ethers.utils.parseEther("110");
        const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
        // mint borrower exactly enough to repay loan
        await mint(mockERC20, borrower, repayAdditionalAmount);
        await mockERC20.connect(borrower).approve(loanCore.address, total);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        // Assess fee on lender
        await feeController.set(await feeController.FL_07(), 20_00);
        await feeController.set(await feeController.FL_08(), 2_00);

        await expect(
            repaymentController.connect(borrower).repay(loanId)
        ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

        expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
        expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("4"));
        expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("106"));
    });

    it("100 ETH principal, 10% interest rate, 5% on principal, none on interest", async () => {
        const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender, feeController } = ctx;

        const { loanId, bundleId } = await initializeLoan(
            ctx,
            mockERC20.address,
            BigNumber.from(86400), // durationSecs
            ethers.utils.parseEther("100"), // principal
            ethers.utils.parseEther("1000"), // interest
            1754884800, // deadline
        );

        // total repayment amount
        const total = ethers.utils.parseEther("110");
        const repayAdditionalAmount = total.sub(await mockERC20.balanceOf(borrower.address));
        // mint borrower exactly enough to repay loan
        await mint(mockERC20, borrower, repayAdditionalAmount);
        await mockERC20.connect(borrower).approve(loanCore.address, total);

        expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);

        // Assess fee on lender
        await feeController.set(await feeController.FL_08(), 5_00);

        await expect(
            repaymentController.connect(borrower).repay(loanId)
        ).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

        expect(await mockERC20.balanceOf(borrower.address)).to.eq(0);
        expect(await mockERC20.balanceOf(loanCore.address)).to.eq(ethers.utils.parseEther("5"));
        expect(await mockERC20.balanceOf(lender.address)).to.eq(ethers.utils.parseEther("105"));
    });

    it("Get full interest with invaild rate, should revert.", async () => {
        const { repaymentController } = ctx;

        await expect(
            repaymentController.getInterestAmount(ethers.utils.parseEther("100"), ethers.utils.parseEther("0.9")),
        ).to.be.revertedWith("FIAC_InterestRate");
    });
});
