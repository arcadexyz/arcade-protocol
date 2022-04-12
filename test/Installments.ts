import { expect } from "chai";
import hre, { ethers, waffle } from "hardhat";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber } from "ethers";

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
import { deploy } from "./utils/contracts";
import { approve, mint } from "./utils/erc20";
import { LoanTerms, LoanData } from "./utils/types";
import { createLoanTermsSignature } from "./utils/eip712";

const SECTION_SEPARATOR = "\n" + "=".repeat(80) + "\n";

const ORIGINATOR_ROLE = "0x59abfac6520ec36a6556b2a4dd949cc40007459bcd5cd2507f1e5cc77b6bc97e";
const REPAYER_ROLE = "0x9c60024347074fd9de2c1e36003080d22dbc76a41ef87444d21e361bcb39118e";

//interest rate parameters
const INTEREST_DENOMINATOR = ethers.utils.parseEther("1"); //1*10**18
const BASIS_POINTS_DENOMINATOR = BigNumber.from(10000);

interface TestContext {
    loanCore: LoanCore;
    mockERC20: MockERC20;
    borrowerNote: PromissoryNote;
    lenderNote: PromissoryNote;
    assetWrapper: VaultFactory;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    borrower: SignerWithAddress;
    lender: SignerWithAddress;
    admin: SignerWithAddress;
    currentTimestamp: number;
}

describe("Implementation", () => {
    const blockchainTime = new BlockchainTime();

    /**
     * Sets up a test asset vault for the user passed as an arg
     */
    const initializeBundle = async (assetWrapper: VaultFactory, user: SignerWithAddress): Promise<BigNumber> => {
        const tx = await assetWrapper.connect(user).initializeBundle(await user.getAddress());
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
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const currentTimestamp = await blockchainTime.secondsFromNow(0);

        const signers: SignerWithAddress[] = await hre.ethers.getSigners();
        const [borrower, lender, admin] = signers;

        const feeController = <FeeController>await deploy("FeeController", admin, []);
        const whitelist = <CallWhitelist>await deploy("CallWhitelist", admin, []);
        const vaultTemplate = <AssetVault>await deploy("AssetVault", admin, []);
        const assetWrapper = <VaultFactory>(
            await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address])
        );
        const loanCore = <LoanCore>await deploy("LoanCore", admin, [assetWrapper.address, feeController.address]);
        const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);

        const originationController = <OriginationController>(
            await deploy("OriginationController", signers[0], [loanCore.address, assetWrapper.address])
        );
        await originationController.deployed();

        const borrowerNoteAddress = await loanCore.borrowerNote();
        const borrowerNote = <PromissoryNote>(
            (await ethers.getContractFactory("PromissoryNote")).attach(borrowerNoteAddress)
        );

        const lenderNoteAddress = await loanCore.lenderNote();
        const lenderNote = <PromissoryNote>(
            (await ethers.getContractFactory("PromissoryNote")).attach(lenderNoteAddress)
        );

        const repaymentController = <RepaymentController>(
            await deploy("RepaymentController", admin, [loanCore.address, borrowerNoteAddress, lenderNoteAddress])
        );
        await repaymentController.deployed();
        const updateRepaymentControllerPermissions = await loanCore.grantRole(
            REPAYER_ROLE,
            repaymentController.address,
        );
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
            assetWrapper,
            repaymentController,
            originationController,
            mockERC20,
            borrower,
            lender,
            admin,
            currentTimestamp
        };
    };

    /**
     * Create a NON-INSTALLMENT LoanTerms object using the given parameters, or defaults
     */
    const createLoanTerms = (
        payableCurrency: string,
        {
            durationSecs = 3600000,
            principal = hre.ethers.utils.parseEther("100"),
            interest = hre.ethers.utils.parseEther("1"),
            collateralTokenId = BigNumber.from(1),
            startDate = 0,
            numInstallments = 0,
        }: Partial<LoanTerms> = {},
    ): LoanTerms => {
        return {
            durationSecs,
            principal,
            interest,
            collateralTokenId,
            payableCurrency,
            startDate,
            numInstallments,
        };
    };

    /**
     * Create an INSTALLMENT LoanTerms object using the given parameters, or defaults
     */
    const createInstallmentLoanTerms = (
        payableCurrency: string,
        durationSecs: number,
        principal: BigNumber,
        interest: BigNumber,
        startDate:number,
        numInstallments:number,
        {
            collateralTokenId = BigNumber.from(1),
        }: Partial<LoanTerms> = {},
    ): LoanTerms => {
        return {
            durationSecs,
            principal,
            interest,
            collateralTokenId,
            payableCurrency,
            startDate,
            numInstallments,
        };
    };

    interface LoanDef {
        loanId: string;
        bundleId: BigNumber;
        loanTerms: LoanTerms;
        loanData: LoanData;
    }

    const initializeLoan = async (context: TestContext, terms?: Partial<LoanTerms>): Promise<LoanDef> => {
        const { originationController, mockERC20, assetWrapper, loanCore, lender, borrower } = context;
        const bundleId = await initializeBundle(assetWrapper, borrower);
        const loanTerms = createLoanTerms(mockERC20.address, { collateralTokenId: bundleId });
        await mint(mockERC20, lender, loanTerms.principal);

        const { v, r, s } = await createLoanTermsSignature(
            originationController.address,
            "OriginationController",
            loanTerms,
            borrower,
        );

        await approve(mockERC20, lender, originationController.address, loanTerms.principal);
        await assetWrapper.connect(borrower).approve(originationController.address, bundleId);
        const tx = await originationController
                .connect(lender)
                .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), v, r, s);
        const receipt = await tx.wait();

        let loanId;

        if (receipt && receipt.events && receipt.events.length == 15) {
            const LoanCreatedLog = new hre.ethers.utils.Interface([
                "event LoanStarted(uint256 loanId, address lender, address borrower)",
            ]);
            const log = LoanCreatedLog.parseLog(receipt.events[14]);
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

    const initializeInstallmentLoan = async (context: TestContext, payableCurrency: string, durationSecs: number, principal:BigNumber, interest:BigNumber, startDate:number, numInstallments:number, terms?: Partial<LoanTerms>): Promise<LoanDef> => {
        const { originationController, mockERC20, assetWrapper, loanCore, lender, borrower } = context;
        const bundleId = await initializeBundle(assetWrapper, borrower);
        const loanTerms = createInstallmentLoanTerms(
            payableCurrency,
            durationSecs,
            principal,
            interest,
            startDate,
            numInstallments,
            { collateralTokenId: bundleId }
        );
        if (terms) Object.assign(loanTerms, terms);
        await mint(mockERC20, lender, loanTerms.principal);
        await mint(mockERC20, borrower, ethers.utils.parseEther("10000")); // for when they need additional liquidity ( lot of payments missed)

        const { v, r, s } = await createLoanTermsSignature(
            originationController.address,
            "OriginationController",
            loanTerms,
            borrower,
        );

        await approve(mockERC20, lender, originationController.address, loanTerms.principal);
        await assetWrapper.connect(borrower).approve(originationController.address, bundleId);
        const tx = await originationController
                .connect(lender)
                .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), v, r, s);
        const receipt = await tx.wait();

        let loanId;

        if (receipt && receipt.events && receipt.events.length == 15) {
            const LoanCreatedLog = new hre.ethers.utils.Interface([
                "event LoanStarted(uint256 loanId, address lender, address borrower)",
            ]);
            const log = LoanCreatedLog.parseLog(receipt.events[14]);
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

    // *********************** INSTALLMENT TESTS *******************************

    it("Tries to create installment loan type with 0 installments.", async () => {
        console.log(" ----- TEST 1 ----- ")
        const context = await loadFixture(fixture);
        const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
        const { loanId, loanTerms, loanData, bundleId } = await initializeLoan(context);

        await mint(mockERC20, borrower, loanTerms.principal.add(loanTerms.interest));
        await mockERC20
            .connect(borrower)
            .approve(repaymentController.address, loanTerms.principal.add(loanTerms.interest));
        expect(await assetWrapper.ownerOf(bundleId)).to.equal(loanCore.address);

        await expect(
            repaymentController.connect(borrower).getInstallmentMinPayment(loanData.borrowerNoteId),
        ).to.be.revertedWith("This loan type does not have any installments.");
    });

    it("Create an installment loan with 4 installments periods and a loan duration of 36000. Call repayPart to pay the minimum on the first installment period.", async () => {
        console.log(" ----- TEST 2 ----- ")
        const context = await loadFixture(fixture);
        const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
        const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
            mockERC20.address,
            36000, // durationSecs
            hre.ethers.utils.parseEther("100"), // principal
            hre.ethers.utils.parseEther("1000"), // interest
            currentTimestamp, // startDate
            4 // numInstallments
        );

        //const bal = await mockERC20.connect(borrower).balanceOf(borrower.address);
        //console.log("Borrower's balance before repaying installment (ETH): ", ethers.utils.formatEther(bal));
        await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.50"));
        await expect(
          repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
        ).to.emit(mockERC20, "Transfer");
    });

    it("Create an installment loan with 4 installments periods and a loan duration of 36000. Call repayPart to pay the minimum on the first installment period. With Allowance set to less than amount due. Should Revert.", async () => {
        console.log(" ----- TEST 3 ----- ")
        const context = await loadFixture(fixture);
        const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
        const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
            mockERC20.address,
            36000, // durationSecs
            hre.ethers.utils.parseEther("100"), // principal
            hre.ethers.utils.parseEther("1000"), // interest
            currentTimestamp, // startDate
            4 // numInstallments
        );

        await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("2.49"));
        //await repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId);
        await expect(
          repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
        ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
    });
    it("Create an installment loan with 4 installments periods and a loan duration of 36000. Skip the first period, then call repayPart. Pay the minimum balance due with late fees. ", async () => {
        console.log(" ----- TEST 4 ----- ")
        const context = await loadFixture(fixture);
        const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
        const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
            mockERC20.address,
            36000, // durationSecs
            hre.ethers.utils.parseEther("100"), // principal
            hre.ethers.utils.parseEther("1000"), // interest
            currentTimestamp, // startDate
            4 // numInstallments
        );
        //increase one installment period
        await blockchainTime.increaseTime(36000/4);

        await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("3.0125"));
        await expect(
          repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
        ).to.emit(mockERC20, "Transfer");
    });

    it("Create an installment loan with 4 installments periods and a loan duration of 36000. Skip the first two instalment periods, then call repayPart. Pay the minimum balance due with late fees. ", async () => {
        console.log(" ----- TEST 5 ----- ")
        const context = await loadFixture(fixture);
        const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
        const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
            mockERC20.address,
            36000, // durationSecs
            hre.ethers.utils.parseEther("100"), // principal
            hre.ethers.utils.parseEther("1000"), // interest
            currentTimestamp, // startDate
            4 // numInstallments
        );
        //increase two installment period
        await blockchainTime.increaseTime((36000/4) + (36000/4));

        await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("6.1128125"));
        await expect(
          repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
        ).to.emit(mockERC20, "Transfer");
    });

    it("Create an installment loan with 4 installments periods and a loan duration of 36000. Skip the first two instalment periods, then call repayPart. Pay the minimum balance due with late fees. Should revert with insufficient allowance sent. ", async () => {
        console.log(" ----- TEST 6 ----- ")
        const context = await loadFixture(fixture);
        const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
        const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
            mockERC20.address,
            36000, // durationSecs
            hre.ethers.utils.parseEther("100"), // principal
            hre.ethers.utils.parseEther("1000"), // interest
            currentTimestamp, // startDate
            4 // numInstallments
        );
        //increase two installment period
        await blockchainTime.increaseTime((36000/4) + (36000/4));

        await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("6.1128124"));
        await expect(
          repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
        ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
    });

    it("Create an installment loan with 4 installments periods and a loan duration of 36000. Skip the first three instalment periods, then call repayPart. Pay the minimum balance due with late fees. Should revert with insufficient allowance sent. ", async () => {
        console.log(" ----- TEST 7 ----- ")
        const context = await loadFixture(fixture);
        const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
        const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
            mockERC20.address,
            36000, // durationSecs
            hre.ethers.utils.parseEther("100"), // principal
            hre.ethers.utils.parseEther("1000"), // interest
            currentTimestamp, // startDate
            4 // numInstallments
        );
        //increase three installment period
        await blockchainTime.increaseTime((36000/4) + (36000/4) + (36000/4));

        await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("9.3784453125"));
        await expect(
          repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
        ).to.emit(mockERC20, "Transfer");
    });

    it("Create an installment loan with 4 installments periods and a loan duration of 36000. Skip the first three instalment periods, then call repayPart. Pay the minimum balance due with late fees. Should revert with insufficient allowance sent. ", async () => {
        console.log(" ----- TEST 8 ----- ")
        const context = await loadFixture(fixture);
        const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
        const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
            mockERC20.address,
            36000, // durationSecs
            hre.ethers.utils.parseEther("100"), // principal
            hre.ethers.utils.parseEther("1000"), // interest
            currentTimestamp, // startDate
            4 // numInstallments
        );
        //increase three installment period
        await blockchainTime.increaseTime((36000/4) + (36000/4) + (36000/4));

        await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("9.3784453124"));
        await expect(
          repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
        ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
    });

    it("Should return installment period and number of installments missed when relative current time is outside loan duration. This case is 1 period overdue. " , async () => {
      const context = await loadFixture(fixture);
      const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
      const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
          mockERC20.address,
          36000, // durationSecs
          hre.ethers.utils.parseEther("100"), // principal
          hre.ethers.utils.parseEther("1000"), // interest
          currentTimestamp, // startDate
          4 // numInstallments
      );
      //increase 4 installment periods
      await blockchainTime.increaseTime((36000) + (36000/4));

      await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("16.74"));
      await expect(
        repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
      ).to.emit(mockERC20, "Transfer");
    });

    it("Should return installment period and number of installments missed when relative current time is outside loan duration. This case is 1 period overdue. " , async () => {
      const context = await loadFixture(fixture);
      const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
      const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
          mockERC20.address,
          36000, // durationSecs
          hre.ethers.utils.parseEther("100"), // principal
          hre.ethers.utils.parseEther("1000"), // interest
          currentTimestamp, // startDate
          4 // numInstallments
      );
      //increase 4 installment periods
      await blockchainTime.increaseTime((36000) + (36000));

      await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("31.31"));
      await expect(
        repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
      ).to.emit(mockERC20, "Transfer");
    });

    it("Should return installment period and number of installments missed when relative current time is outside loan duration. This case is 4 periods overdue. " , async () => {
      const context = await loadFixture(fixture);
      const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
      const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
          mockERC20.address,
          36000, // durationSecs
          hre.ethers.utils.parseEther("100"), // principal
          hre.ethers.utils.parseEther("1000"), // interest
          currentTimestamp, // startDate
          4 // numInstallments
      );
      //increase 4 installment periods
      await blockchainTime.increaseTime((36000) + (36000));

      await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("31.30"));
      await expect(
        repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
      ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
    });

    it("Should return installment period and number of installments missed when relative current time is outside loan duration. This case is 4 periods overdue. " , async () => {
      const context = await loadFixture(fixture);
      const { repaymentController, assetWrapper, mockERC20, loanCore, borrower, lender, currentTimestamp } = context;
      const { loanId, loanTerms, loanData, bundleId } = await initializeInstallmentLoan(context,
          mockERC20.address,
          36000, // durationSecs
          hre.ethers.utils.parseEther("100"), // principal
          hre.ethers.utils.parseEther("1000"), // interest
          currentTimestamp, // startDate
          4 // numInstallments
      );
      //increase 4 installment periods
      await blockchainTime.increaseTime((36000) * 10);

      await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("5393"));
      await expect(
        repaymentController.connect(borrower).repayPartMinimum(loanData.borrowerNoteId)
      ).to.emit(mockERC20, "Transfer");
    });
});
