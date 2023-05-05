import { expect } from "chai";
import hre, { ethers, waffle } from "hardhat";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber, BigNumberish } from "ethers";

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
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { mint as mint721 } from "./utils/erc721";
import { deploy } from "./utils/contracts";
import { approve, mint } from "./utils/erc20";
import { LoanTerms, LoanData, ItemsPredicate, SignatureItem } from "./utils/types";
import { createLoanTermsSignature, createLoanItemsSignature } from "./utils/eip712";
import { encodePredicates, encodeSignatureItems } from "./utils/loans";

const ORIGINATOR_ROLE = "0x59abfac6520ec36a6556b2a4dd949cc40007459bcd5cd2507f1e5cc77b6bc97e";
const REPAYER_ROLE = "0x9c60024347074fd9de2c1e36003080d22dbc76a41ef87444d21e361bcb39118e";

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

describe("Rollovers", () => {
    const blockchainTime = new BlockchainTime();

    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const blockchainTime = new BlockchainTime();
        const currentTimestamp = await blockchainTime.secondsFromNow(0);

        const signers: SignerWithAddress[] = await hre.ethers.getSigners();
        const [borrower, lender, admin, newLender] = signers;

        const whitelist = <CallWhitelist>await deploy("CallWhitelist", signers[0], []);
        const vaultTemplate = <AssetVault>await deploy("AssetVault", signers[0], []);
        const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address])

        const feeController = <FeeController>await deploy("FeeController", admin, []);

        await feeController.set(await feeController.FL_02(), 50);
        await feeController.set(await feeController.FL_04(), 10);

        const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN"]);
        const lenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN"]);

        const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [borrowerNote.address, lenderNote.address]);

        // Grant correct permissions for promissory note
        for (const note of [borrowerNote, lenderNote]) {
            await note.connect(admin).initialize(loanCore.address);
        }

        const updateborrowerPermissions = await loanCore.grantRole(ORIGINATOR_ROLE, borrower.address);
        await updateborrowerPermissions.wait();

        const mockERC20 = <MockERC20>await deploy("MockERC20", admin, ["Mock ERC20", "MOCK"]);
        const mockERC721 = <MockERC721>await deploy("MockERC721", admin, ["Mock ERC721", "MOCK"]);

        const repaymentController = <RepaymentController>await deploy("RepaymentController", admin, [loanCore.address]);
        await repaymentController.deployed();
        const updateRepaymentControllerPermissions = await loanCore.grantRole(
            REPAYER_ROLE,
            repaymentController.address,
        );
        await updateRepaymentControllerPermissions.wait();

        const originationController = <OriginationController>await deploy(
            "OriginationController", signers[0], [loanCore.address, feeController.address]
        );
        await originationController.deployed();

        // admin whitelists MockERC20 on OriginationController
        const whitelistCurrency = await originationController.allowPayableCurrency([mockERC20.address]);
        await whitelistCurrency.wait();
        // verify the currency is whitelisted
        const isWhitelisted = await originationController.allowedCurrencies(mockERC20.address);
        expect(isWhitelisted).to.be.true;
        // admin whitelists MockERC721 and vaultFactory on OriginationController
        const whitelistCollateral = await originationController.allowCollateralAddress([mockERC721.address]);
        await whitelistCollateral.wait();
        const whitelistVaultFactory = await originationController.allowCollateralAddress([vaultFactory.address]);
        await whitelistVaultFactory.wait();
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

        const verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", admin, []);
        await originationController.setAllowedVerifier(verifier.address, true);

        return {
            loanCore,
            borrowerNote,
            lenderNote,
            vaultFactory,
            repaymentController,
            originationController,
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
    const createLoanTerms = (
        payableCurrency: string,
        collateralAddress: string,
        {
            durationSecs = BigNumber.from(3600000),
            principal = hre.ethers.utils.parseEther("100"),
            interestRate = hre.ethers.utils.parseEther("1"),
            collateralId = 1,
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
            deadline,
        };
    };

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

    const initializeLoan = async (
        context: TestContext,
        payableCurrency: string,
        durationSecs: BigNumberish,
        principal: BigNumber,
        interestRate: BigNumber,
        deadline: BigNumberish,
        nonce = 1,
    ): Promise<LoanDef> => {
        const { originationController, mockERC20, vaultFactory, loanCore, lender, borrower } = context;
        const bundleId = await initializeBundle(vaultFactory, borrower);
        const loanTerms = createLoanTerms(payableCurrency, vaultFactory.address, {
            durationSecs,
            principal,
            interestRate,
            deadline,
            collateralId: bundleId,
        });

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

    describe("Rollover Loan", () => {
        let ctx: TestContext;
        let loan: LoanDef;

        const DEADLINE = 1754884800;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            loan = await initializeLoan(
                ctx,
                ctx.mockERC20.address,
                BigNumber.from(86400),
                hre.ethers.utils.parseEther("100"), // principal
                hre.ethers.utils.parseEther("1000"), // interest
                DEADLINE,
            );
        });

        it("should not allow a rollover if the collateral doesn't match", async () => {
            const { originationController, vaultFactory, borrower, lender } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(
                ctx.mockERC20.address,
                vaultFactory.address,
                { ...loanTerms, collateralId: BigNumber.from(bundleId).add(1) }, // different bundle ID
            );

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "3",
                2,
                "l",
            );

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, 2),
            ).to.be.revertedWith("OC_RolloverCollateralMismatch");
        });

        it("should not allow a rollover if the loan currencies don't match", async () => {
            const { originationController, vaultFactory, borrower, lender, admin } = ctx;
            const { loanId, loanTerms } = loan;

            const otherERC20 = <MockERC20>await deploy("MockERC20", admin, ["Mock ERC20", "MOCK"]);

            const whitelistCurrency = await originationController.allowPayableCurrency([otherERC20.address]);
            await whitelistCurrency.wait();

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(
                otherERC20.address, // different currency
                vaultFactory.address,
                loanTerms,
            );

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "3",
                2,
                "l",
            );

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, 2),
            ).to.be.revertedWith("OC_RolloverCurrencyMismatch");
        });

        it("should not allow a rollover on an already closed loan", async () => {
            const { originationController, repaymentController, mockERC20, vaultFactory, borrower, lender, admin } =
                ctx;
            const { loanId, loanTerms } = loan;

            // Repay the loan
            await mockERC20.connect(admin).mint(borrower.address, ethers.utils.parseEther("1000"));
            await mockERC20.connect(borrower).approve(repaymentController.address, ethers.utils.parseEther("1000"));
            await repaymentController.connect(borrower).repay(loanId);

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "3",
                2,
                "l",
            );

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, 2),
            ).to.be.revertedWith("OC_InvalidState");
        });

        it("should not allow a rollover if called by a third party", async () => {
            const { originationController, mockERC20, vaultFactory, lender, newLender } = ctx;
            const { loanId, loanTerms } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "3",
                2,
                "l",
            );

            await expect(
                // newLender not a counterparty
                originationController.connect(newLender).rolloverLoan(loanId, newTerms, lender.address, sig, 2),
            ).to.be.revertedWith("OC_CallerNotParticipant");
        });

        it("should not allow a rollover if signed by the old lender", async () => {
            const { originationController, mockERC20, vaultFactory, borrower, lender, newLender } = ctx;
            const { loanId, loanTerms } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "3",
                2,
                "l",
            );

            await expect(
                // newLender not a counterparty
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, 2),
            ).to.be.revertedWith("OC_InvalidSignature");
        });

        it("should not allow a rollover if called by the old lender", async () => {
            const { originationController, mockERC20, vaultFactory, lender, newLender } = ctx;
            const { loanId, loanTerms } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                newLender,
                "3",
                2,
                "l",
            );

            await expect(
                // newLender not a counterparty
                originationController.connect(lender).rolloverLoan(loanId, newTerms, newLender.address, sig, 2),
            ).to.be.revertedWith("OC_CallerNotParticipant");
        });

        it("should roll over to the same lender", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "3",
                2,
                "l",
            );

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, 2))
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

            // Borrower pays interest + rollover fee
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10.1"));
            // Lender collects interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("10"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates rollover fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("0.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should fail to roll over an already closed loan", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                "3",
                2,
                "l",
            );

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("25"));

            const newLoanId = Number(loanId) + 1;

            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, 2))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId)
                .to.emit(loanCore, "LoanStarted")
                .withArgs(newLoanId, lender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver")
                .withArgs(loanId, newLoanId);

            // Try to roll over again
            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, 2),
            ).to.be.revertedWith("OC_InvalidState");
        });

        it("should roll over to a different lender", async () => {
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
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                newLender,
                "3",
                2,
                "l",
            );

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

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

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, 2),
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

            // Borrower pays interest + rollover fee
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10.1"));
            // Old lender collects full principal + interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("110"));
            // New lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("100"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates rollover fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("0.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should roll over to a different lender, called by the lender", async () => {
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
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                borrower,
                "3",
                2,
                "b",
            );

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

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

            await expect(
                originationController.connect(newLender).rolloverLoan(loanId, newTerms, newLender.address, sig, 2),
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

            // Borrower pays interest + rollover fee
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10.1"));
            // Old lender collects full principal + interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("110"));
            // New lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("100"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates rollover fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("0.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should roll over to a different lender using an items signature", async () => {
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
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            const collateralId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleId.toString(), collateralId);

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

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
                encodePredicates(predicates),
                newLender,
                "3",
                "2",
                "l",
            );

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

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

            await expect(
                originationController
                    .connect(borrower)
                    .rolloverLoanWithItems(loanId, newTerms, newLender.address, sig, 2, predicates),
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

            // Borrower pays interest + rollover fee
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10.1"));
            // Old lender collects full principal + interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("110"));
            // New lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("100"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates rollover fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("0.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should roll over to the same lender using an items signature", async () => {
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
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            const collateralId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleId.toString(), collateralId);

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, loanTerms);

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
                encodePredicates(predicates),
                lender,
                "3",
                "2",
                "l",
            );

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("12"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            await expect(
                originationController
                    .connect(borrower)
                    .rolloverLoanWithItems(loanId, newTerms, lender.address, sig, 2, predicates),
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

            // Borrower pays interest + rollover fee
            expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.eq(ethers.utils.parseUnits("10.1"));
            // Lender collects interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("10"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates rollover fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("0.1"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should roll over a loan with for the borrower and the same lender where no funds need to move", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            // Have new principal be exactly what is due:
            // Old principal + interest + new origination fee
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("110.11011011011011011"),
            });

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                "3",
                2,
                "l",
            );

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(lender.address, ethers.utils.parseEther("200"));
            await mockERC20.connect(lender).approve(originationController.address, ethers.utils.parseEther("200"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("100"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, 2))
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

            // Borrower gets principal difference - interest - rollover fee
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.eq(ethers.utils.parseUnits("0"));
            // Lender pays fee only
            expect(lenderBalanceBefore.sub(lenderBalanceAfter)).to.eq(ethers.utils.parseUnits("0.11011011011011011"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates rollover fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(
                ethers.utils.parseUnits("0.110110110110110110"),
            );

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should roll over a loan with extra principal for the borrower and the same lender", async () => {
            const {
                originationController,
                mockERC20,
                vaultFactory,
                borrower,
                lender,
                borrowerNote,
                lenderNote,
                loanCore,
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("200"),
            });

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                lender,
                "3",
                2,
                "l",
            );

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(lender.address, ethers.utils.parseEther("100"));
            await mockERC20.connect(lender).approve(originationController.address, ethers.utils.parseEther("100"));
            await mockERC20.connect(borrower).approve(originationController.address, ethers.utils.parseEther("100"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            await expect(originationController.connect(borrower).rolloverLoan(loanId, newTerms, lender.address, sig, 2))
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

            // Borrower gets principal difference - interest - rollover fee
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.eq(ethers.utils.parseUnits("89.8"));
            // Lender pays new principal - amount due - interest
            expect(lenderBalanceBefore.sub(lenderBalanceAfter)).to.eq(ethers.utils.parseUnits("90"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates rollover fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("0.2"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(lender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });

        it("should roll over a loan with extra principal for the borrower and a different lender", async () => {
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
            } = ctx;
            const { loanId, loanTerms, bundleId } = loan;

            // create new terms for rollover and sign them
            const newTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                ...loanTerms,
                principal: ethers.utils.parseEther("200"),
            });

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                newTerms,
                newLender,
                "3",
                2,
                "l",
            );

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1
            await mockERC20.mint(newLender.address, ethers.utils.parseEther("200"));
            await mockERC20.connect(newLender).approve(originationController.address, ethers.utils.parseEther("200"));

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const lenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const ocBalanceBefore = await mockERC20.balanceOf(originationController.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            const newLoanId = Number(loanId) + 1;

            await expect(
                originationController.connect(borrower).rolloverLoan(loanId, newTerms, newLender.address, sig, 2),
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

            // Borrower gets principal difference - interest - rollover fee
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.eq(ethers.utils.parseUnits("89.8"));
            // Old lender collects full principal + interest
            expect(lenderBalanceAfter.sub(lenderBalanceBefore)).to.eq(ethers.utils.parseUnits("110"));
            // Lender pays new principal
            expect(newLenderBalanceBefore.sub(newLenderBalanceAfter)).to.eq(ethers.utils.parseUnits("200"));
            // Nothing left in Origination Controller
            expect(ocBalanceAfter.sub(ocBalanceBefore)).to.eq(0);
            // LoanCore accumulates rollover fee
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.eq(ethers.utils.parseUnits("0.2"));

            expect(await borrowerNote.ownerOf(newLoanId)).to.eq(borrower.address);
            expect(await lenderNote.ownerOf(newLoanId)).to.eq(newLender.address);
            expect(await vaultFactory.ownerOf(bundleId)).to.eq(loanCore.address);
            expect(await loanCore.canCallOn(borrower.address, bundleId.toString())).to.eq(true);
        });
    });
});
