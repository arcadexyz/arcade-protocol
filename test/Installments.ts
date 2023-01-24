import { expect } from "chai";
import hre, { ethers, waffle, upgrades } from "hardhat";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber, BigNumberish } from "ethers";
import {
    OriginationController,
    PromissoryNote,
    RepaymentController,
    LoanCore,
    MockERC20,
    MockERC721,
    AssetVault,
    CallWhitelist,
    VaultFactory,
    FeeController,
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { deploy } from "./utils/contracts";
import { approve, mint } from "./utils/erc20";
import { LoanTerms, LoanData, LoanState } from "./utils/types";
import { createLoanTermsSignature } from "./utils/eip712";

const ORIGINATOR_ROLE = "0x59abfac6520ec36a6556b2a4dd949cc40007459bcd5cd2507f1e5cc77b6bc97e";
const REPAYER_ROLE = "0x9c60024347074fd9de2c1e36003080d22dbc76a41ef87444d21e361bcb39118e";
const BURNER_ROLE = "0x3c11d16cbaffd01df69ce1c404f6340ee057498f5f00246190ea54220576a848";
const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const PAUSER_ROLE = "65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a";

interface TestContext {
    loanCore: LoanCore;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    borrowerNote: PromissoryNote;
    lenderNote: PromissoryNote;
    vaultFactory: VaultFactory;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    borrower: SignerWithAddress;
    lender: SignerWithAddress;
    admin: SignerWithAddress;
    currentTimestamp: number;
    blockchainTime: BlockchainTime;
}

interface LoanDef {
    loanId: string;
    bundleId: BigNumberish;
    loanTerms: LoanTerms;
    loanData: LoanData;
}

/**
 * Set up a test asset vault for the user passed as a parameter
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
 * Set up a test context, deploying new contracts and returning them for use in tests
 */
const fixture = async (): Promise<TestContext> => {
    const blockchainTime = new BlockchainTime();
    const currentTimestamp = await blockchainTime.secondsFromNow(0);

    const signers: SignerWithAddress[] = await hre.ethers.getSigners();
    const [borrower, lender, admin] = signers;

    const whitelist = <CallWhitelist>await deploy("CallWhitelist", admin, []);
    const vaultTemplate = <AssetVault>await deploy("AssetVault", admin, []);
    const VaultFactoryFactory = await hre.ethers.getContractFactory("VaultFactory");
    const vaultFactory = <VaultFactory>(
        await upgrades.deployProxy(VaultFactoryFactory, [vaultTemplate.address, whitelist.address], { kind: "uups" })
    );

    const feeController = <FeeController>await deploy("FeeController", admin, []);

    const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN"]);
    const lenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN"]);

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
        await note.connect(admin).initialize(loanCore.address);
    }

    const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);
    const mockERC721 = <MockERC721>await deploy("MockERC721", signers[0], ["Mock ERC721", "MOCK"]);

    const OriginationController = await hre.ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>(
        await upgrades.deployProxy(OriginationController, [loanCore.address], { kind: "uups" })
    );
    await originationController.deployed();

    const repaymentController = <RepaymentController>await deploy("RepaymentController", admin, [loanCore.address]);
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
        repaymentController,
        originationController,
        mockERC20,
        mockERC721,
        vaultFactory,
        borrower,
        lender,
        admin,
        currentTimestamp,
        blockchainTime,
    };
};

/**
 * Create a NON-INSTALLMENT loan using the given parameters, or defaults
 */
const createLoanTerms = (
    payableCurrency: string,
    collateralAddress: string,
    {
        durationSecs = BigNumber.from(3600000),
        principal = hre.ethers.utils.parseEther("100"),
        interestRate = hre.ethers.utils.parseEther("1"),
        collateralId = 1,
        numInstallments = 0,
        deadline = 1754884800,
    }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        interestRate,
        collateralAddress,
        collateralId,
        payableCurrency,
        numInstallments,
        deadline,
    };
};

/**
 * Create an INSTALLMENT loan using the given parameters, or default
 */
const createInstallmentLoanTerms = (
    payableCurrency: string,
    durationSecs: BigNumber,
    principal: BigNumber,
    interestRate: BigNumber,
    collateralAddress: string,
    numInstallments: number,
    deadline: BigNumberish,
    { collateralId = 1 }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        interestRate,
        collateralAddress,
        collateralId,
        payableCurrency,
        numInstallments,
        deadline,
    };
};

/**
 * Initialize a loan WITHOUT installments
 */
const initializeLoan = async (context: TestContext): Promise<LoanDef> => {
    const { originationController, mockERC20, vaultFactory, loanCore, lender, borrower } = context;
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

    const tx = await originationController
        .connect(lender)
        .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1);
    const receipt = await tx.wait();

    let loanId;
    if (receipt && receipt.events) {
        const loanCreatedLog = new hre.ethers.utils.Interface([
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

/**
 * Initialize a loan WITH installments
 */
const initializeInstallmentLoan = async (
    context: TestContext,
    payableCurrency: string,
    durationSecs: BigNumber,
    principal: BigNumber,
    interestRate: BigNumber,
    numInstallments: number,
    deadline: BigNumberish,
    terms?: Partial<LoanTerms>,
): Promise<LoanDef> => {
    const { originationController, mockERC20, vaultFactory, loanCore, lender, borrower } = context;
    const bundleId = await initializeBundle(vaultFactory, borrower);
    const loanTerms = createInstallmentLoanTerms(
        payableCurrency,
        durationSecs,
        principal,
        interestRate,
        vaultFactory.address,
        numInstallments,
        deadline,
        { collateralId: bundleId },
    );
    if (terms) Object.assign(loanTerms, terms);
    await mint(mockERC20, lender, loanTerms.principal);
    // for when borrower needs additional liquidity (lot of payments missed)
    await mint(mockERC20, borrower, ethers.utils.parseEther("10000"));

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
    const tx = await originationController
        .connect(lender)
        .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1);
    const receipt = await tx.wait();

    let loanId;
    if (receipt && receipt.events) {
        const loanCreatedLog = new hre.ethers.utils.Interface([
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

// ======================= INSTALLMENTS TESTS =======================

describe("Installments", () => {
    describe("getInstallmentMinPayment", () => {
        it("reverts if the loan ID is invalid", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, blockchainTime } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(100000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                8, // numInstallments
                1754884800, // deadline
            );

            //increase one installment period
            await blockchainTime.increaseTime(100000 / 8);

            // Check invalid loan ID
            await expect(
                repaymentController.connect(borrower).getInstallmentMinPayment(Number(loanId) * 2),
            ).to.be.revertedWith("RC_CannotDereference");
        });

        it("reverts for an already closed loan", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, lender, blockchainTime } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );

            //increase time slightly
            await blockchainTime.increaseTime(10);

            const res = await repaymentController.connect(borrower).callStatic.amountToCloseLoan(loanId);
            const amountDue = res[0];
            const numMissedPayments = res[1].toNumber();
            expect(amountDue).to.equal(ethers.utils.parseEther("102.5"));
            expect(numMissedPayments).to.equal(0);

            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("102.5"));
            await expect(repaymentController.connect(borrower).closeLoan(loanId))
                .to.emit(mockERC20, "Transfer")
                .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("102.5"));

            await expect(repaymentController.connect(borrower).getInstallmentMinPayment(loanId)).to.be.revertedWith(
                "RC_InvalidState",
            );
        });
    });

    describe("Installment Period", () => {
        it("Create a loan with 1 installment period, should revert.", async () => {
            const context = await loadFixture(fixture);
            const { mockERC20 } = context;
            await expect(
                initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(86400), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    1, // numInstallments
                    BigNumber.from(259200),
                ),
            ).to.be.revertedWith("OC_NumberInstallments");
        });

        it("Create a loan with 1001 installment periods, should revert.", async () => {
            const context = await loadFixture(fixture);
            const { mockERC20 } = context;
            await expect(
                initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(86400), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    1001, // numInstallments
                    BigNumber.from(259200),
                ),
            ).to.be.revertedWith("OC_NumberInstallments");
        });

        it("Create a loan with interest rate greater than 1e18 and less than 1e26.", async () => {
            const context = await loadFixture(fixture);
            const { mockERC20 } = context;
            await expect(
                initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(86400), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000001"), // interest 10,000.01%
                    2, // numInstallments
                    1754884800, // deadline
                ),
            ).to.be.revertedWith("OC_InterestRate");
        });

        it("Create a loan with invalid signature deadline.", async () => {
            const context = await loadFixture(fixture);
            const { mockERC20 } = context;
            await expect(
                initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(86400), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    11, // numInstallments
                    BigNumber.from(259200), //deadline
                ),
            ).to.be.revertedWith("OC_SignatureIsExpired");
        });

        it("Verify missed payments equals zero.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, blockchainTime } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );

            //increase time barely, so getInstallmentMinPayment fn call does not occur in the same block
            await blockchainTime.increaseTime(1);

            const res = await repaymentController.connect(borrower).callStatic.getInstallmentMinPayment(loanId);
            const minInterestDue = res[0];
            const lateFees = res[1];
            const numMissedPayments = res[2].toNumber();
            expect(minInterestDue).to.equal(ethers.utils.parseEther("2.5"));
            expect(lateFees).to.equal(ethers.utils.parseEther("0"));
            expect(numMissedPayments).to.equal(0);
        });

        it("reverts if trying to repay part on a closed loan", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, blockchainTime } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );

            //increase time slightly
            await blockchainTime.increaseTime(10);

            const res = await repaymentController.connect(borrower).callStatic.amountToCloseLoan(loanId);
            const amountDue = res[0];
            const numMissedPayments = res[1].toNumber();
            expect(amountDue).to.equal(ethers.utils.parseEther("102.5"));
            expect(numMissedPayments).to.equal(0);

            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("210"));
            await expect(repaymentController.connect(borrower).closeLoan(loanId))
                .to.emit(mockERC20, "Transfer")
                .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("102.5"));

            await expect(
                repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("102.5")),
            ).to.be.revertedWith("RC_InvalidState");
        });

        it("Fast Forward to 2nd period. Verify missed payments equals one.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, blockchainTime } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(100000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                8, // numInstallments
                1754884800, // deadline
            );

            //increase one installment period
            await blockchainTime.increaseTime(100000 / 8);

            const res = await repaymentController.connect(borrower).callStatic.getInstallmentMinPayment(loanId);
            const minInterestDue = res[0];
            const lateFees = res[1];
            const numMissedPayments = res[2].toNumber();
            expect(minInterestDue).to.equal(ethers.utils.parseEther("2.521875"));
            expect(lateFees).to.equal(ethers.utils.parseEther("0.5"));
            expect(numMissedPayments).to.equal(1);
        });

        it("Fast Forward to 5th period. Verify missed payments equals four.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, blockchainTime } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(100000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                8, // numInstallments
                1754884800, // deadline
            );

            //increase four installment periods
            await blockchainTime.increaseTime(100000 / 8 + 100000 / 8 + 100000 / 8 + 100000 / 8);

            const res = await repaymentController.connect(borrower).callStatic.getInstallmentMinPayment(loanId);
            const minInterestDue = res[0];
            const lateFees = res[1];
            const numMissedPayments = res[2].toNumber();
            expect(minInterestDue).to.equal(ethers.utils.parseEther("6.536242480517578125"));
            expect(lateFees).to.equal(ethers.utils.parseEther("2.063202679687500000"));
            expect(numMissedPayments).to.equal(4);
        });

        it("Fast Forward to 6th period. Verify missed payments equals five.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, blockchainTime } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(86400 * 365), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                10, // numInstallments
                1754884800, // deadline
            );

            //increase half the loan duration
            await blockchainTime.increaseTime((86400 * 365) / 2);

            const res = await repaymentController.connect(borrower).callStatic.getInstallmentMinPayment(loanId);
            const minInterestDue = res[0];
            const lateFees = res[1];
            const numMissedPayments = res[2].toNumber();
            expect(minInterestDue).to.equal(ethers.utils.parseEther("6.331972372009375"));
            expect(lateFees).to.equal(ethers.utils.parseEther("2.6015226503125"));
            expect(numMissedPayments).to.equal(5);
        });

        it("Pay first installment then miss 2 payments. Verify missed payments equals two.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, blockchainTime, loanCore } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );
            // pay first installment
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                .to.emit(loanCore, "InstallmentPaymentReceived")
                .withArgs(loanId, ethers.utils.parseEther("0"), ethers.utils.parseEther("100"));
            //increase three installment periods
            await blockchainTime.increaseTime(36000 / 4 + 36000 / 4 + 36000 / 4);

            const res = await repaymentController.connect(borrower).callStatic.getInstallmentMinPayment(loanId);
            const minInterestDue = res[0];
            const lateFees = res[1];
            const numMissedPayments = res[2].toNumber();
            expect(minInterestDue).to.equal(ethers.utils.parseEther("7.73975"));
            expect(lateFees).to.equal(ethers.utils.parseEther("1.015"));
            expect(numMissedPayments).to.equal(2);
        });

        it("Miss first installment, pay second, then miss 4 payments. Verify missed payments equals four.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, blockchainTime, loanCore } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                8, // numInstallments
                1754884800, // deadline
            );
            //increase time to the second installment period
            await blockchainTime.increaseTime(36000 / 8 + 10);

            // pay first installment
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("3.021875"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                .to.emit(loanCore, "InstallmentPaymentReceived")
                .withArgs(loanId, ethers.utils.parseEther("0"), ethers.utils.parseEther("100"));
            //increase four installment periods
            await blockchainTime.increaseTime(36000 / 8 + 36000 / 8 + 36000 / 8 + 36000 / 8 + 36000 / 8);

            const res = await repaymentController.connect(borrower).callStatic.getInstallmentMinPayment(loanId);
            const minInterestDue = res[0];
            const lateFees = res[1];
            const numMissedPayments = res[2].toNumber();
            expect(minInterestDue).to.equal(ethers.utils.parseEther("6.536242480517578125"));
            expect(lateFees).to.equal(ethers.utils.parseEther("2.0632026796875"));
            expect(numMissedPayments).to.equal(4);
        });
    });

    describe("Installment Repayments", () => {
        it("Scenario: numInstallments: 0. Tries to use legacy loan with installment repay functions.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, vaultFactory, loanCore } = context;
            const { loanId, bundleId, loanTerms } = await initializeLoan(context);

            await mint(mockERC20, borrower, loanTerms.principal.add(loanTerms.interestRate));
            await mockERC20
                .connect(borrower)
                .approve(repaymentController.address, loanTerms.principal.add(loanTerms.interestRate));
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            await expect(repaymentController.connect(borrower).getInstallmentMinPayment(loanId)).to.be.revertedWith(
                "RC_NoInstallments",
            );
        });

        it("Scenario: numInstallments: 0. Tries to use installment loan with legacy repay functions.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, vaultFactory, loanCore } = context;
            const { loanId, bundleId, loanTerms } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                8, // numInstallments
                1754884800, // deadline
            );

            await mint(mockERC20, borrower, loanTerms.principal.add(loanTerms.interestRate));
            await mockERC20
                .connect(borrower)
                .approve(repaymentController.address, loanTerms.principal.add(loanTerms.interestRate));
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            await expect(repaymentController.connect(borrower).repay(loanId)).to.be.revertedWith("RC_HasInstallments");
        });

        it("Scenario: numInstallments: 8, durationSecs: 36000, principal: 100, interest: 10%. Repay minimum on first payment.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, lender, blockchainTime, loanCore } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                8, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

            //increase time barely
            await blockchainTime.increaseTime(10);

            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("1.25"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                .to.emit(mockERC20, "Transfer")
                .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("1.25"));

            //increase time
            await blockchainTime.increaseTime(100);
            // try to repay again in same period
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.be.revertedWith(
                "RC_NoPaymentDue",
            );

            const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
            expect(loanDATA.balance).to.equal(ethers.utils.parseEther("100"));
            expect(loanDATA.state).to.equal(LoanState.Active);
            expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("1.25"));

            const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
            await expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore.sub(ethers.utils.parseEther("1.25")));
            await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("1.25")));
        });

        it("Scenario: numInstallments: 4, durationSecs: 36000, principal: 100, interest: 10%. Repay minimum on first payment.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower, lender, loanCore, blockchainTime } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

            //increase time barely
            await blockchainTime.increaseTime(10);

            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                .to.emit(loanCore, "InstallmentPaymentReceived")
                .withArgs(loanId, ethers.utils.parseEther("0"), ethers.utils.parseEther("100"));

            const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
            expect(loanDATA.balance).to.equal(ethers.utils.parseEther("100"));
            expect(loanDATA.state).to.equal(LoanState.Active);
            expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("2.5"));

            const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
            await expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore.sub(ethers.utils.parseEther("2.5")));
            await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("2.5")));
        });

        it("Scenario: numInstallments: 4, durationSecs: 36000, principal: 100, interest: 10%. Pay the minimum with insufficient allowance, should revert.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());

            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.49"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.be.revertedWith(
                "ERC20: transfer amount exceeds allowance",
            );

            await expect(await mockERC20.balanceOf(await borrower.getAddress())).to.equal(borrowerBalanceBefore);
        });

        describe("Late Payments", () => {
            it("Scenario: numInstallments: 4, durationSecs: 36000, principal: 100, interest: 10%. Make repayment after one skipped payment. ", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, blockchainTime, lender, loanCore } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());
                // increase one installment period
                await blockchainTime.increaseTime(36000 / 4 + 10);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("5.575"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("5.575"),
                    );

                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("100"));
                expect(loanDATA.state).to.equal(LoanState.Active);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("5.575"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("5.575")),
                );
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("5.575")));
            });

            it("Scenario: numInstallments: 4, durationSecs: 36000, principal: 100, interest: 10%. Make repayment after two skipped payments.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, lender, blockchainTime, loanCore } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());
                //increase two installment period
                await blockchainTime.increaseTime(36000 / 4 + 36000 / 4);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("8.75475"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("8.75475"),
                    );

                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("100"));
                expect(loanDATA.state).to.equal(LoanState.Active);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("8.75475"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("8.75475")),
                );
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("8.75475")));
            });

            it("Scenario: numInstallments: 4, durationSecs: 36000, principal: 100, interest: 10%. Pay the minimum with insufficient allowance, should revert.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                //increase two installment period
                await blockchainTime.increaseTime(36000 / 4 + 36000 / 4);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("8.75474"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.be.revertedWith(
                    "ERC20: transfer amount exceeds allowance",
                );
            });

            it("Scenario: numInstallments: 4, durationSecs: 36000, principal: 100, interest: 10%. Make repayment after three skipped payments.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, lender, blockchainTime, loanCore } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                //increase three installment period
                await blockchainTime.increaseTime(36000 / 4 + 36000 / 4 + 36000 / 4);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("12.0577675"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("12.0577675"),
                    );

                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("100"));
                expect(loanDATA.state).to.equal(LoanState.Active);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("12.0577675"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("12.0577675")),
                );
                await expect(lenderBalanceAfter).to.equal(
                    lenderBalanceBefore.add(ethers.utils.parseEther("12.0577675")),
                );
            });

            describe("After Loan Duration Payments", () => {
                it("Repay minimum after missing loan duration and 1 extra period.", async () => {
                    const context = await loadFixture(fixture);
                    const { repaymentController, mockERC20, borrower, lender, blockchainTime, loanCore } = context;
                    const { loanId } = await initializeInstallmentLoan(
                        context,
                        mockERC20.address,
                        BigNumber.from(36000), // durationSecs
                        hre.ethers.utils.parseEther("100"), // principal
                        hre.ethers.utils.parseEther("1000"), // interest
                        4, // numInstallments
                        1754884800, // deadline
                    );
                    const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                    const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                    //increase 4 installment periods
                    await blockchainTime.increaseTime(36000 + 36000 / 4);

                    await mockERC20
                        .connect(borrower)
                        .approve(repaymentController.address, ethers.utils.parseEther("19.11319634075"));
                    await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                        .to.emit(mockERC20, "Transfer")
                        .withArgs(
                            await borrower.getAddress(),
                            repaymentController.address,
                            ethers.utils.parseEther("19.11319634075"),
                        );

                    const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                    expect(loanDATA.balance).to.equal(ethers.utils.parseEther("100"));
                    expect(loanDATA.state).to.equal(LoanState.Active);
                    expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("19.11319634075"));

                    const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                    const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                    await expect(borrowerBalanceAfter).to.equal(
                        borrowerBalanceBefore.sub(ethers.utils.parseEther("19.11319634075")),
                    );
                    await expect(lenderBalanceAfter).to.equal(
                        lenderBalanceBefore.add(ethers.utils.parseEther("19.11319634075")),
                    );
                });

                it("Repay minimum after missing loan duration and 1 extra period, with insufficient allowance, should revert.", async () => {
                    const context = await loadFixture(fixture);
                    const { repaymentController, mockERC20, borrower, blockchainTime } = context;
                    const { loanId } = await initializeInstallmentLoan(
                        context,
                        mockERC20.address,
                        BigNumber.from(36000), // durationSecs
                        hre.ethers.utils.parseEther("100"), // principal
                        hre.ethers.utils.parseEther("1000"), // interest
                        4, // numInstallments
                        1754884800, // deadline
                    );
                    const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());

                    //increase 4 installment periods
                    await blockchainTime.increaseTime(36000 + 36000 / 4);

                    await mockERC20
                        .connect(borrower)
                        .approve(repaymentController.address, ethers.utils.parseEther("19.11319634074"));
                    await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.be.revertedWith(
                        "ERC20: transfer amount exceeds allowance",
                    );

                    await expect(await mockERC20.balanceOf(await borrower.getAddress())).to.equal(
                        borrowerBalanceBefore,
                    );
                });

                it("Repay minimum after skipping whole loan duration x 2.", async () => {
                    const context = await loadFixture(fixture);
                    const { repaymentController, mockERC20, borrower, lender, blockchainTime, loanCore } = context;
                    const { loanId } = await initializeInstallmentLoan(
                        context,
                        mockERC20.address,
                        BigNumber.from(36000), // durationSecs
                        hre.ethers.utils.parseEther("100"), // principal
                        hre.ethers.utils.parseEther("1000"), // interest
                        4, // numInstallments
                        1754884800, // deadline
                    );
                    const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                    const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                    //increase 4 installment periods
                    await blockchainTime.increaseTime(36000 + 36000);

                    await mockERC20
                        .connect(borrower)
                        .approve(repaymentController.address, ethers.utils.parseEther("31.15279066794581275"));
                    await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                        .to.emit(mockERC20, "Transfer")
                        .withArgs(
                            await borrower.getAddress(),
                            repaymentController.address,
                            ethers.utils.parseEther("31.15279066794581275"),
                        );

                    const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                    expect(loanDATA.balance).to.equal(ethers.utils.parseEther("100"));
                    expect(loanDATA.state).to.equal(LoanState.Active);
                    expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("31.15279066794581275"));

                    const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                    const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                    await expect(borrowerBalanceAfter).to.equal(
                        borrowerBalanceBefore.sub(ethers.utils.parseEther("31.15279066794581275")),
                    );
                    await expect(lenderBalanceAfter).to.equal(
                        lenderBalanceBefore.add(ethers.utils.parseEther("31.15279066794581275")),
                    );
                });

                it("Repay minimum after skipping whole loan duration x 10.", async () => {
                    const context = await loadFixture(fixture);
                    const { repaymentController, mockERC20, borrower, lender, blockchainTime, loanCore } = context;
                    const { loanId } = await initializeInstallmentLoan(
                        context,
                        mockERC20.address,
                        BigNumber.from(36000), // durationSecs
                        hre.ethers.utils.parseEther("100"), // principal
                        hre.ethers.utils.parseEther("1000"), // interest
                        4, // numInstallments
                        1754884800, // deadline
                    );
                    const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                    const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                    //increase 4 installment periods
                    await blockchainTime.increaseTime(36000 * 10);

                    await mockERC20
                        .connect(borrower)
                        .approve(repaymentController.address, ethers.utils.parseEther("630.929509200042118676"));
                    await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                        .to.emit(mockERC20, "Transfer")
                        .withArgs(
                            await borrower.getAddress(),
                            repaymentController.address,
                            ethers.utils.parseEther("630.929509200042118676"),
                        );

                    const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                    expect(loanDATA.balance).to.equal(ethers.utils.parseEther("100"));
                    expect(loanDATA.state).to.equal(LoanState.Active);
                    expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("630.929509200042118676"));

                    const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                    const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                    await expect(borrowerBalanceAfter).to.equal(
                        borrowerBalanceBefore.sub(ethers.utils.parseEther("630.929509200042118676")),
                    );
                    await expect(lenderBalanceAfter).to.equal(
                        lenderBalanceBefore.add(ethers.utils.parseEther("630.929509200042118676")),
                    );
                });
            });
        });

        describe("Multiple Repayments", () => {
            it("Scenario: numInstallments: 8, durationSecs: 36000, principal: 100, interest: 10%. Repay minimum on first two repayments.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, lender, blockchainTime, loanCore } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    8, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("1.25"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("1.25"),
                    );

                await blockchainTime.increaseTime(36000 / 8);

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("1.25"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("1.25"),
                    );

                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("100"));
                expect(loanDATA.state).to.equal(LoanState.Active);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("2.5"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore.sub(ethers.utils.parseEther("2.5")));
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("2.5")));
            });

            it("Scenario: numInstallments: 4, durationSecs: 36000, principal: 100, interest: 10%. Repay the minimum interest plus 1/4 the principal for four consecutive payments.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());
                // increase time slightly
                await blockchainTime.increaseTime(10);

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("27.5"));
                await expect(repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("27.5")))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("27.5"),
                    );

                await blockchainTime.increaseTime(36000 / 4);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("26.875"));
                await expect(repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("26.875")))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("26.875"),
                    );

                await blockchainTime.increaseTime(36000 / 4);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("26.25"));
                await expect(repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("26.25")))
                    .to.emit(loanCore, "InstallmentPaymentReceived")
                    .withArgs(loanId, ethers.utils.parseEther("25.0"), ethers.utils.parseEther("25.0"));

                await blockchainTime.increaseTime(36000 / 4);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("25.625"));
                await expect(repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("25.625")))
                    .to.emit(loanCore, "LoanRepaid")
                    .withArgs(loanId);

                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(0);
                expect(loanDATA.state).to.equal(LoanState.Repaid);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("106.25"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("106.25")),
                );
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("106.25")));
            });

            it("Scenario: numInstallments: 8, durationSecs: 72000, principal: 100, interest: 10%. Repay the minimum plus 1/4 the principal for four payments every other period.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(72000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    8, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                // increase to the second installment period
                await blockchainTime.increaseTime(72000 / 8 + 100);

                // 3.021875ETH + 25ETH
                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("28.021875"));
                await expect(
                    repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("28.021875")),
                )
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("28.021875"),
                    );
                // increase to the fourth installment
                await blockchainTime.increaseTime(72000 / 4);
                // 1.34313ETH + 25ETH
                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("27.26640625"));
                await expect(
                    repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("27.26640625")),
                )
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("27.26640625"),
                    );
                // increase to the sixth installment period
                await blockchainTime.increaseTime(72000 / 4);

                // 0.92913ETH + 25ETH
                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("26.5109375"));
                await expect(
                    repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("26.5109375")),
                )
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("26.5109375"),
                    );
                // increase to the last installment period
                await blockchainTime.increaseTime(72000 / 4);

                // 0.43601ETH + 25ETH
                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("25.75546875"));
                await expect(
                    repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("25.75546875")),
                )
                    .to.emit(loanCore, "LoanRepaid")
                    .withArgs(loanId);

                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(0);
                expect(loanDATA.state).to.equal(LoanState.Repaid);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("107.5546875"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("107.5546875")),
                );
                await expect(lenderBalanceAfter).to.equal(
                    lenderBalanceBefore.add(ethers.utils.parseEther("107.5546875")),
                );
            });

            it("Scenario: numInstallments: 12, durationSecs: 1y, principal: 1000, interest: 6.25%. Repay minimum on 12 payments, verify the principal has not changed.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(31536000), // durationSecs
                    hre.ethers.utils.parseEther("1000"), // principal
                    hre.ethers.utils.parseEther("625"), // interest
                    12, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                //increase time barely, so getInstallmentMinPayment fn call does not occur in the same block
                await blockchainTime.increaseTime(1);

                for (let i = 0; i < 12; i++) {
                    await mockERC20
                        .connect(borrower)
                        .approve(repaymentController.address, ethers.utils.parseEther("5.2083333"));
                    await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                        .to.emit(mockERC20, "Transfer")
                        .withArgs(
                            await borrower.getAddress(),
                            repaymentController.address,
                            ethers.utils.parseEther("5.2083333"),
                        );
                    // increase to the next installment period
                    await blockchainTime.increaseTime(31536000 / 12);
                }

                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("1000"));
                expect(loanDATA.state).to.equal(LoanState.Active);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("62.4999996"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("62.4999996")),
                );
                await expect(lenderBalanceAfter).to.equal(
                    lenderBalanceBefore.add(ethers.utils.parseEther("62.4999996")),
                );
            });

            it("Scenario: numInstallments: 12, durationSecs: 1y, principal: 100000, interest: 10.00%. Repay min interest and monthly principal x 12.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(31536000), // durationSecs
                    hre.ethers.utils.parseEther("100000"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    12, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                //increase time barely, so getInstallmentMinPayment fn call does not occur in the same block
                await blockchainTime.increaseTime(1);

                for (let i = 0; i < 12; i++) {
                    await mockERC20
                        .connect(borrower)
                        .approve(repaymentController.address, ethers.utils.parseEther("8791.599")); // first and maximum repayment
                    await expect(
                        repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("8791.599")),
                    )
                        .to.emit(mockERC20, "Transfer")
                        .withArgs(
                            await borrower.getAddress(),
                            repaymentController.address,
                            ethers.utils.parseEther("8791.599"),
                        );
                    //increase one installment period
                    await blockchainTime.increaseTime(31536000 / 12);
                }

                // verify loanData after 12 txs on time
                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("0"));
                expect(loanDATA.state).to.equal(LoanState.Repaid);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("105499.058840292240863275"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("105499.058840292240863275")),
                );
                await expect(lenderBalanceAfter).to.equal(
                    lenderBalanceBefore.add(ethers.utils.parseEther("105499.058840292240863275")),
                );
            });

            it("Scenario: numInstallments: 4, durationSecs: 1y, principal: 100, interest: 10.00%. Repay min interest and monthly principal x 4.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(31536000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                // increase time barely, so getInstallmentMinPayment fn call does not occur in the same block
                await blockchainTime.increaseTime(1);

                for (let i = 0; i < 4; i++) {
                    await mockERC20
                        .connect(borrower)
                        .approve(repaymentController.address, ethers.utils.parseEther("27.5")); // first and maximum repayment
                    await expect(
                        repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("27.5")),
                    )
                        .to.emit(mockERC20, "Transfer")
                        .withArgs(
                            await borrower.getAddress(),
                            repaymentController.address,
                            ethers.utils.parseEther("27.5"),
                        );
                    // increase one installment period
                    await blockchainTime.increaseTime(31536000 / 4);
                }

                // verify loanData after 4 txs on time
                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("0"));
                expect(loanDATA.state).to.equal(LoanState.Repaid);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("106.187109375"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("106.187109375")),
                );
                await expect(lenderBalanceAfter).to.equal(
                    lenderBalanceBefore.add(ethers.utils.parseEther("106.187109375")),
                );
            });

            it("Repay everything with repayPart after paying 2 minimum payments (in second installment period).", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, lender, loanCore, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                //increase time slightly
                await blockchainTime.increaseTime(10);

                //repay minimum
                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

                //increase time
                await blockchainTime.increaseTime(36000 / 4);
                //repay minimum
                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

                //increase time slightly, but still same installment period
                await blockchainTime.increaseTime(1);
                // repay entire principal to close the loan
                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("100"));
                await expect(repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("100")))
                    .to.emit(loanCore, "LoanRepaid")
                    .withArgs(loanId);

                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("0"));
                expect(loanDATA.state).to.equal(LoanState.Repaid);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("105"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore.sub(ethers.utils.parseEther("105")));
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("105")));
            });

            it("Scenario: numInstallments: 4, durationSecs: 1y, principal: 100, interest: 10.00%. Repay min interest x 1 and 1/4 principal, then pay off rest of loan.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(31536000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                //increase time barely, so getInstallmentMinPayment fn call does not occur in the same block
                await blockchainTime.increaseTime(1);

                // 1st payment
                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("27.5")); // first and maximum repayment
                await expect(repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("27.5")))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("27.5"),
                    );

                // increase one installment period
                await blockchainTime.increaseTime(31536000 / 4);

                // second payment
                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("76.875")); // first and maximum repayment
                await expect(repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("76.875")))
                    .to.emit(loanCore, "LoanRepaid")
                    .withArgs(loanId);

                // verify loanData after 4 txs on time
                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("0"));
                expect(loanDATA.state).to.equal(LoanState.Repaid);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("104.375"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("104.375")),
                );
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("104.375")));
            });

            it("Scenario: numInstallments: 24, durationSecs: 2y, principal: 1000, interest: 0.75%. Repay minimum on 24 payments, verify the principal has changed.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(31536000 * 2), // durationSecs
                    hre.ethers.utils.parseEther("1000"), // principal
                    hre.ethers.utils.parseEther("75"), // interest
                    24, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                //increase time barely, so getInstallmentMinPayment fn call does not occur in the same block
                await blockchainTime.increaseTime(1);

                for (let i = 0; i < 24; i++) {
                    await mockERC20
                        .connect(borrower)
                        .approve(repaymentController.address, ethers.utils.parseEther(".3125"));
                    await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                        .to.emit(mockERC20, "Transfer")
                        .withArgs(
                            await borrower.getAddress(),
                            repaymentController.address,
                            ethers.utils.parseEther("0.3125"),
                        );

                    await blockchainTime.increaseTime((31536000 * 2) / 24);
                }

                const loanDATA = await loanCore.connect(borrower).getLoan(loanId);
                expect(loanDATA.balance).to.equal(ethers.utils.parseEther("1000"));
                expect(loanDATA.state).to.equal(LoanState.Active);
                expect(loanDATA.balancePaid).to.equal(ethers.utils.parseEther("7.5"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore.sub(ethers.utils.parseEther("7.5")));
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("7.5")));
            });

            it("Send zero as amount for repayPart call.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(31536000 * 2), // durationSecs
                    hre.ethers.utils.parseEther("1000"), // principal
                    hre.ethers.utils.parseEther("75"), // interest
                    24, // numInstallments
                    1754884800, // deadline
                );
                await blockchainTime.increaseTime(10);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther(".3125"));
                await expect(
                    repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("0")),
                ).to.be.revertedWith("RC_RepayPartZero");

                await expect(
                    repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther(".1")),
                ).to.be.revertedWith("RC_RepayPartLTMin");
            });

            it("borrower tries to close loan after paying back only 1/10 of total interest", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, loanCore, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(31536000), // durationSecs = 1 year
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest rate = 10% -> 10 Ether
                    10, // numInstallments
                    1754884800, // deadline
                );
                await blockchainTime.increaseTime(10);

                const res = await repaymentController.connect(borrower).callStatic.getInstallmentMinPayment(loanId);
                const minInterestDue = res[0];

                // borrower pays back 1 ether in interest
                await mockERC20.connect(borrower).approve(repaymentController.address, minInterestDue);
                await repaymentController.connect(borrower).repayPart(loanId, minInterestDue);

                // try incrementing numInstallmentPaid by sending 1 wei
                for (let i = 0; i < 10; i++) {
                    await mockERC20.connect(borrower).approve(repaymentController.address, 1);
                    await repaymentController.connect(borrower).repayPart(loanId, 1);
                }

                await blockchainTime.increaseTime(31536000);

                // after loan ends, borrower tries to pay back only principal
                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("100"));
                await expect(
                    repaymentController.connect(borrower).closeLoan(loanId)
                ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");

                // state checks
                const loanData = await loanCore.getLoan(loanId);
                const balancePaid = loanData[5];
                const numInstallmentsPaid = loanData[1];
                const loanState = loanData[0];
                expect(loanState).to.equal(1);
                expect(numInstallmentsPaid).to.equal(1);
                expect(balancePaid).to.equal(ethers.utils.parseEther("1").add(10));
            });

            it("borrower tries to close loan after paying back only interest", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(31536000), // durationSecs = 1 year
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest rate = 10% -> 10 Ether
                    10, // numInstallments
                    1754884800, // deadline
                );
                await blockchainTime.increaseTime(10);

                // repay only interest with repayPart
                for (let i = 0; i < 10; i++) {
                    const res = await repaymentController.connect(borrower).callStatic.getInstallmentMinPayment(loanId);
                    const minInterestDue = res[0];
                    const lateFees = res[1];

                    await mockERC20.connect(borrower).approve(repaymentController.address, minInterestDue.add(lateFees));
                    await repaymentController.connect(borrower).repayPart(loanId, minInterestDue.add(lateFees));

                    await blockchainTime.increaseTime(31536000/10);
                }

                // after loan ends, borrower tries to pay with less then total principal
                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("99.99"));
                await expect(
                    repaymentController.connect(borrower).closeLoan(loanId)
                ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");

                // state checks
                const loanData = await loanCore.getLoan(loanId);
                const balancePaid = loanData[5];
                const numInstallmentsPaid = loanData[1];
                const loanState = loanData[0];
                expect(loanState).to.equal(1);
                expect(numInstallmentsPaid).to.equal(10);
                expect(balancePaid).to.equal(ethers.utils.parseEther("10"));
            });

            it("borrower tries to close loan after paying back only interest", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, loanCore, borrower, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(31536000), // durationSecs = 1 year
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest rate = 10% -> 10 Ether
                    10, // numInstallments
                    1754884800, // deadline
                );
                await blockchainTime.increaseTime(10);

                // repay only interest
                for (let i = 0; i < 10; i++) {
                    const res = await repaymentController.connect(borrower).callStatic.getInstallmentMinPayment(loanId);
                    const minInterestDue = res[0];
                    const lateFees = res[1];

                    await mockERC20.connect(borrower).approve(repaymentController.address, minInterestDue.add(lateFees));
                    await repaymentController.connect(borrower).repayPartMinimum(loanId);

                    await blockchainTime.increaseTime(31536000/10);
                }

                // after loan ends, borrower tries to pay with less then total principal
                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("99.99"));
                await expect(
                    repaymentController.connect(borrower).closeLoan(loanId)
                ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");

                // state checks
                const loanData = await loanCore.getLoan(loanId);
                const balancePaid = loanData[5];
                const numInstallmentsPaid = loanData[1];
                const loanState = loanData[0];
                expect(loanState).to.equal(1);
                expect(numInstallmentsPaid).to.equal(10);
                expect(balancePaid).to.equal(ethers.utils.parseEther("10"));
            });
        });

        describe("Close Loan", () => {
            it("Close loan in first installment period.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                //increase time slightly
                await blockchainTime.increaseTime(10);

                const res = await repaymentController.connect(borrower).callStatic.amountToCloseLoan(loanId);
                const amountDue = res[0];
                const numMissedPayments = res[1].toNumber();
                expect(amountDue).to.equal(ethers.utils.parseEther("102.5"));
                expect(numMissedPayments).to.equal(0);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("102.5"));
                await expect(repaymentController.connect(borrower).closeLoan(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("102.5"),
                    );

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("102.5")),
                );
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("102.5")));
            });

            it("Close loan in first installment period, but set allowance to less than required. Should revert.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());

                //increase time slightly
                await blockchainTime.increaseTime(10);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("102.4"));
                await expect(repaymentController.connect(borrower).closeLoan(loanId)).to.be.revertedWith(
                    "ERC20: transfer amount exceeds allowance",
                );

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                await expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore);
            });

            it("Close loan in last installment period.", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                //increase time slightly
                await blockchainTime.increaseTime(36000 - 100);

                const res = await repaymentController.connect(borrower).callStatic.amountToCloseLoan(loanId);
                const amountDue = res[0];
                const numMissedPayments = res[1].toNumber();
                expect(amountDue).to.equal(ethers.utils.parseEther("112.0577675"));
                expect(numMissedPayments).to.equal(3);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("112.0577675"));
                await expect(repaymentController.connect(borrower).closeLoan(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("112.0577675"),
                    );

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("112.0577675")),
                );
                await expect(lenderBalanceAfter).to.equal(
                    lenderBalanceBefore.add(ethers.utils.parseEther("112.0577675")),
                );
            });

            it("Close loan after paying 2 min payments (3rd installment period).", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

                // increase time slightly, first installment period
                await blockchainTime.increaseTime(10);

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

                // increase time, second period
                await blockchainTime.increaseTime(36000 / 4);

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

                // increase time, third period
                await blockchainTime.increaseTime(36000 / 4);

                //  pay off rest of the loan
                const res = await repaymentController.connect(borrower).callStatic.amountToCloseLoan(loanId);
                const amountDue = res[0];
                const numMissedPayments = res[1].toNumber();
                expect(amountDue).to.equal(ethers.utils.parseEther("102.5"));
                expect(numMissedPayments).to.equal(0);

                await mockERC20
                    .connect(borrower)
                    .approve(repaymentController.address, ethers.utils.parseEther("102.5"));
                await expect(repaymentController.connect(borrower).closeLoan(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("102.5"),
                    );

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(
                    borrowerBalanceBefore.sub(ethers.utils.parseEther("107.5")),
                );
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("107.5")));
            });

            it("Close loan after paying 2 min payments (2nd installment period).", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());
                //increase time slightly
                await blockchainTime.increaseTime(10);

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

                //increase time
                await blockchainTime.increaseTime(36000 / 4);

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

                //increase time slightly, but still same installment period
                await blockchainTime.increaseTime(1);

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("100"));
                await expect(repaymentController.connect(borrower).closeLoan(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("100"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore.sub(ethers.utils.parseEther("105")));
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("105")));
            });

            it("Close loan after paying 1 minimum payment, 1 repayPart for half the principal (2nd installment period).", async () => {
                const context = await loadFixture(fixture);
                const { repaymentController, mockERC20, borrower, lender, blockchainTime } = context;
                const { loanId } = await initializeInstallmentLoan(
                    context,
                    mockERC20.address,
                    BigNumber.from(36000), // durationSecs
                    hre.ethers.utils.parseEther("100"), // principal
                    hre.ethers.utils.parseEther("1000"), // interest
                    4, // numInstallments
                    1754884800, // deadline
                );
                const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());
                //increase time slightly
                await blockchainTime.increaseTime(10);

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
                await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

                //increase time
                await blockchainTime.increaseTime(36000 / 4);

                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("52.5"));
                await expect(repaymentController.connect(borrower).repayPart(loanId, ethers.utils.parseEther("52.5")))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(
                        await borrower.getAddress(),
                        repaymentController.address,
                        ethers.utils.parseEther("52.5"),
                    );

                //increase time slightly, but still same installment period
                await blockchainTime.increaseTime(1);
                //  pay off rest of the loan
                await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("50"));
                await expect(repaymentController.connect(borrower).closeLoan(loanId))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("50"));

                const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
                const lenderBalanceAfter = await mockERC20.balanceOf(await lender.getAddress());
                await expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore.sub(ethers.utils.parseEther("105")));
                await expect(lenderBalanceAfter).to.equal(lenderBalanceBefore.add(ethers.utils.parseEther("105")));
            });
        });
    });

    describe("Defaults", () => {
        it("Scenario: numInstallments: 2, durationSecs: 36000. Claim after first missed installment.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                2, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time to the second half of the loan duration
            await blockchainTime.increaseTime(36000 / 2 + 100);

            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            // check balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(1);
        });

        it("Scenario: numInstallments: 2, durationSecs: 36000. Borrower calls claim after first missed installment, should revert.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, borrower, lender, blockchainTime } = context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                2, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await mockERC20.balanceOf(await lender.getAddress());

            //increase time to the second half of the loan duration
            await blockchainTime.increaseTime(36000 / 2 + 100);

            // have lender call claim on the collateral
            await expect(repaymentController.connect(borrower).claim(loanId)).to.be.revertedWith("RC_OnlyLender");
        });

        it("Scenario: numInstallments: 2, durationSecs: 36000. Claim in first installment period should revert.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                2, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time to the second half of the loan duration
            await blockchainTime.increaseTime(100);

            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");

            // check balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(0);
        });

        it("Scenario: numInstallments: 4, durationSecs: 36000. Claim after first missed installment, should revert.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time to the second half of the loan duration
            await blockchainTime.increaseTime(36000 / 4 + 100);

            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");

            // check balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(0);
        });

        it("Scenario: numInstallments: 4, durationSecs: 36000. Claim after 40% the loan duration, should revert still second installment period.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time to the second half of the loan duration
            await blockchainTime.increaseTime(36000 * 0.4);

            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");

            // check balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(0);
        });

        it("Scenario: numInstallments: 4, durationSecs: 36000. Borrower repays minimum. Lender tries to claim in same installment, should revert", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time slightly
            await blockchainTime.increaseTime(100);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                .to.emit(mockERC20, "Transfer")
                .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

            await blockchainTime.increaseTime(1);

            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");

            // check balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(0);
        });

        it("Scenario: numInstallments: 4, durationSecs: 36000. Borrower repays minimum. Lender tries to claim in second installment, should revert", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time slightly
            await blockchainTime.increaseTime(100);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                .to.emit(mockERC20, "Transfer")
                .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

            //increase time to second installment period and try to claim before repayment
            await blockchainTime.increaseTime(36000 / 4);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");

            // check balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(0);
        });

        it("Scenario: numInstallments: 4, durationSecs: 36000. Borrower repays minimum. Lender tries to claim various times in loan duration.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time slightly
            await blockchainTime.increaseTime(1);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                .to.emit(mockERC20, "Transfer")
                .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("2.5"));

            //increase time 25% of duration (second installment period)
            await blockchainTime.increaseTime(36000 * 0.25);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");

            //increase time 15% of duration (still second installment period)
            await blockchainTime.increaseTime(36000 * 0.15);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");

            //increase time 10% of duration (third installment period)
            await blockchainTime.increaseTime(36000 * 0.1);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // increase time 10% of duration (start of forth installment period)
            await blockchainTime.increaseTime(36000 * 0.25);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            // check balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(1);
        });

        it("Scenario: numInstallments: 10, durationSecs: 36000. Borrower repays minimum. Lender tries to claim various times in loan duration.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(36000), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                10, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time slightly
            await blockchainTime.increaseTime(100);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("1.0"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId))
                .to.emit(mockERC20, "Transfer")
                .withArgs(await borrower.getAddress(), repaymentController.address, ethers.utils.parseEther("1.0"));

            //increase time 25% of duration (second installment period)
            await blockchainTime.increaseTime(3600);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            //increase time 15% of duration (third installment period)
            await blockchainTime.increaseTime(3600);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            //increase time 10% of duration (forth installment period)
            await blockchainTime.increaseTime(3600);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // increase time 10% of duration (fifth installment period)
            await blockchainTime.increaseTime(3600);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // increase time 10% of duration (sixth installment period) ---> claimable
            await blockchainTime.increaseTime(3600);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.emit(loanCore, "LoanClaimed");

            // check balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(1);
        });

        it("Scenario: numInstallments: 24, durationSecs: 2y. Borrower repays minimum. Lender tries to claim various times in loan duration.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(31536000 * 2), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                24, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time slightly
            await blockchainTime.increaseTime(100);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("0.417"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");

            //(second installment period)
            await blockchainTime.increaseTime((2 * (31536000 * 2)) / 24);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            //(forth installment period)
            await blockchainTime.increaseTime((2 * (31536000 * 2)) / 24);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            //(sixth installment period)
            await blockchainTime.increaseTime((2 * (31536000 * 2)) / 24);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // (eigth installment period)
            await blockchainTime.increaseTime((2 * (31536000 * 2)) / 24);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // (tenth installment period)
            await blockchainTime.increaseTime((2 * (31536000 * 2)) / 24);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // (eleventh installment period) ---> claimable
            await blockchainTime.increaseTime((1 * (31536000 * 2)) / 24);
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.emit(loanCore, "LoanClaimed");

            // check balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(1);
        });

        it("Scenario: numInstallments: 4, durationSecs: 1 month. Borrower repays min 4 times and leaves. Lender tries to claim various times in duration.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(31536000 / 12), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                4, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time slightly
            await blockchainTime.increaseTime(100);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");
            //(second installment period)
            await blockchainTime.increaseTime(31536000 / 12 / 4);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // (third installment period)
            await blockchainTime.increaseTime(31536000 / 12 / 4);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // (forth installment period)
            await blockchainTime.increaseTime(31536000 / 12 / 4);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.5"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // (fifth installment period)
            await blockchainTime.increaseTime(31536000 / 12 / 4 - 101);
            // have lender call claim on the collateral --> claimable
            await expect(repaymentController.connect(lender).claim(loanId)).to.emit(loanCore, "LoanClaimed");

            // check ending balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(1);
        });

        it("Scenario: numInstallments: 3, durationSecs: 1 month. Borrower repays min 3 times and leaves. Lender tries to claim various times induration.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(31536000 / 12), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                3, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time slightly (first installment period)
            await blockchainTime.increaseTime(100);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("3.34"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");
            // (second installment period)
            await blockchainTime.increaseTime(31536000 / 12 / 3);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("3.34"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // (beginning of third installment period)
            await blockchainTime.increaseTime(31536000 / 12 / 3 - 101);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("3.34"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // (beginning of forth installment period)
            await blockchainTime.increaseTime(31536000 / 12 / 3);
            // have lender call claim on the collateral --> claimable
            await expect(repaymentController.connect(lender).claim(loanId)).to.emit(loanCore, "LoanClaimed");

            // check ending balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(1);
        });

        it("Scenario: numInstallments: 2, durationSecs: 1 week. Borrower repays min 2 times and leaves. Lender tries to claim various times in duration.", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, loanCore, mockERC20, vaultFactory, borrower, lender, blockchainTime } =
                context;
            const { loanId } = await initializeInstallmentLoan(
                context,
                mockERC20.address,
                BigNumber.from(604800), // durationSecs
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                2, // numInstallments
                1754884800, // deadline
            );
            const borrowerBalanceBefore = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceBefore = await vaultFactory.balanceOf(await lender.getAddress());

            //increase time slightly (first installment period)
            await blockchainTime.increaseTime(100);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("5.00"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");
            // (second installment period)
            await blockchainTime.increaseTime(604800 / 2);
            // borrower repays minimum
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("5.00"));
            await expect(repaymentController.connect(borrower).repayPartMinimum(loanId)).to.emit(mockERC20, "Transfer");
            // have lender call claim on the collateral
            await expect(repaymentController.connect(lender).claim(loanId)).to.be.revertedWith("LC_LoanNotDefaulted");
            // (beginning of third installment period)
            await blockchainTime.increaseTime(604800 / 2 - 101);
            // have lender call claim on the collateral --> claimable
            await expect(repaymentController.connect(lender).claim(loanId)).to.emit(loanCore, "LoanClaimed");

            // check ending balances
            const borrowerBalanceAfter = await vaultFactory.balanceOf(await borrower.getAddress());
            const lenderBalanceAfter = await vaultFactory.balanceOf(await lender.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(0);
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.equal(1);
        });
    });
});
