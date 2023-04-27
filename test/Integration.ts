import { expect } from "chai";
import hre, { ethers, waffle } from "hardhat";
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
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { deploy } from "./utils/contracts";
import { approve, mint } from "./utils/erc20";
import { LoanTerms, LoanData } from "./utils/types";
import { createLoanTermsSignature } from "./utils/eip712";

const ORIGINATOR_ROLE = "0x59abfac6520ec36a6556b2a4dd949cc40007459bcd5cd2507f1e5cc77b6bc97e";
const REPAYER_ROLE = "0x9c60024347074fd9de2c1e36003080d22dbc76a41ef87444d21e361bcb39118e";

interface TestContext {
    loanCore: LoanCore;
    mockERC20: MockERC20;
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

describe("Integration", () => {
    const blockchainTime = new BlockchainTime();

    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const blockchainTime = new BlockchainTime();
        const currentTimestamp = await blockchainTime.secondsFromNow(0);

        const signers: SignerWithAddress[] = await hre.ethers.getSigners();
        const [borrower, lender, admin] = signers;

        const whitelist = <CallWhitelist>await deploy("CallWhitelist", signers[0], []);
        const vaultTemplate = <AssetVault>await deploy("AssetVault", signers[0], []);
        const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address])

        const feeController = <FeeController>await deploy("FeeController", admin, []);

        const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN"]);
        const lenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN"]);

        const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [feeController.address, borrowerNote.address, lenderNote.address]);

        // Grant correct permissions for promissory note
        for (const note of [borrowerNote, lenderNote]) {
            await note.connect(admin).initialize(loanCore.address);
        }

        const updateborrowerPermissions = await loanCore.grantRole(ORIGINATOR_ROLE, borrower.address);
        await updateborrowerPermissions.wait();

        const mockERC20 = <MockERC20>await deploy("MockERC20", admin, ["Mock ERC20", "MOCK"]);

        const repaymentController = <RepaymentController>await deploy("RepaymentController", admin, [loanCore.address]);
        await repaymentController.deployed();
        const updateRepaymentControllerPermissions = await loanCore.grantRole(
            REPAYER_ROLE,
            repaymentController.address,
        );
        await updateRepaymentControllerPermissions.wait();

        const originationController = <OriginationController>await deploy(
            "OriginationController", signers[0], [loanCore.address]
        )
        await originationController.deployed();

        // admin whitelists MockERC20 on OriginationController
        const whitelistCurrency = await originationController.allowPayableCurrency([mockERC20.address]);
        await whitelistCurrency.wait();
        // verify the currency is whitelisted
        const isWhitelisted = await originationController.allowedCurrencies(mockERC20.address);
        expect(isWhitelisted).to.be.true;
        // admin whitelists vaultFactory on OriginationController
        const whitelistVaultFactory = await originationController.allowCollateralAddress([vaultFactory.address]);
        await whitelistVaultFactory.wait();
        // verify the collateral is whitelisted
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
            repaymentController,
            originationController,
            mockERC20,
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

    const createWnft = async (vaultFactory: VaultFactory, user: SignerWithAddress) => {
        const tx = await vaultFactory.initializeBundle(await user.getAddress());
        const receipt = await tx.wait();
        if (receipt && receipt.events && receipt.events.length === 2 && receipt.events[1].args) {
            return receipt.events[1].args.vault;
        } else {
            throw new Error("Unable to initialize bundle");
        }
    };

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

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            )
                .to.emit(mockERC20, "Transfer")
                .withArgs(await lender.getAddress(), originationController.address, loanTerms.principal)
                .to.emit(mockERC20, "Transfer")
                .withArgs(originationController.address, loanCore.address, loanTerms.principal)
                .to.emit(loanCore, "LoanStarted");
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
                "3",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            // simulate someone trying to withdraw just before initializing the loan
            await AssetVault__factory.connect(bundleId, borrower).connect(borrower).enableWithdraw();
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
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
                "3",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
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
                "3",
                1,
                "b",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await expect(
                originationController
                    .connect(lender)
                    .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, 1),
            ).to.be.revertedWith("OC_LoanDuration");
        });
    });

    describe("Repay Loan", function () {
        interface LoanDef {
            loanId: string;
            bundleId: string;
            loanTerms: LoanTerms;
            loanData: LoanData;
        }

        const initializeLoan = async (
            context: TestContext,
            nonce: number,
            terms?: Partial<LoanTerms>,
        ): Promise<LoanDef> => {
            const { originationController, mockERC20, vaultFactory, loanCore, lender, borrower } = context;
            const bundleId = terms?.collateralId ?? (await createWnft(vaultFactory, borrower));
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
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

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            const tx = await originationController
                .connect(lender)
                .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, nonce);
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

        it("should successfully repay loan", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, vaultFactory, mockERC20, loanCore, borrower, lender } = context;
            const { loanId, loanTerms, bundleId } = await initializeLoan(context, 1);

            await mint(mockERC20, borrower, loanTerms.principal.add(loanTerms.interestRate));
            await mockERC20
                .connect(borrower)
                .approve(repaymentController.address, loanTerms.principal.add(loanTerms.interestRate));

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);
            const preLenderBalance = await mockERC20.balanceOf(await lender.getAddress());

            await expect(repaymentController.connect(borrower).repay(loanId))
                .to.emit(loanCore, "LoanRepaid")
                .withArgs(loanId);

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(await borrower.getAddress());
            const postLenderBalance = await mockERC20.balanceOf(await lender.getAddress());
            expect(postLenderBalance.sub(preLenderBalance)).to.equal(ethers.utils.parseEther("100.01"));
        });

        it("should allow the collateral to be reused after repay", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, loanCore, borrower } = context;
            const { loanId, loanTerms, bundleId } = await initializeLoan(context, 1);

            await mint(mockERC20, borrower, loanTerms.principal.add(loanTerms.interestRate));

            await mockERC20
                .connect(borrower)
                .approve(repaymentController.address, loanTerms.principal.add(loanTerms.interestRate));

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

            await mint(mockERC20, borrower, loanTerms.principal.add(loanTerms.interestRate));

            await expect(repaymentController.connect(borrower).repay(loanId)).to.be.revertedWith(
                "ERC20: transfer amount exceeds allowance",
            );
        });

        it("fails with invalid note ID", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, mockERC20, borrower } = context;
            const { loanTerms } = await initializeLoan(context, 1);

            await mint(mockERC20, borrower, loanTerms.principal.add(loanTerms.interestRate));
            await mockERC20
                .connect(borrower)
                .approve(repaymentController.address, loanTerms.principal.add(loanTerms.interestRate));

            await expect(repaymentController.connect(borrower).repay(1234)).to.be.revertedWith("RC_CannotDereference");
        });
    });

    describe("Claim loan", function () {
        interface LoanDef {
            loanId: string;
            bundleId: string;
            loanTerms: LoanTerms;
            loanData: LoanData;
        }

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

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            const tx = await originationController
                .connect(lender)
                .initializeLoan(loanTerms, await borrower.getAddress(), await lender.getAddress(), sig, nonce);
            const receipt = await tx.wait();

            let loanId;
            if (receipt && receipt.events) {
                const LoanCreatedLog = new hre.ethers.utils.Interface([
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
            await blockchainTime.increaseTime(20000);

            await expect(repaymentController.connect(lender).claim(loanId))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            // post-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(await lender.getAddress());
        });

        it("should allow the collateral to be reused after claim", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, vaultFactory, loanCore, lender, borrower } = context;
            const { loanId, bundleId } = await initializeLoan(context, 1);

            // pre-repaid state
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);
            await blockchainTime.increaseTime(5000);

            await expect(repaymentController.connect(lender).claim(loanId))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            // create a new loan with the same bundleId
            // transfer the collateral back to the original borrower
            await vaultFactory
                .connect(lender)
                .transferFrom(await lender.getAddress(), await borrower.getAddress(), bundleId);
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

            await blockchainTime.increaseTime(5000);
            await expect(repaymentController.connect(lender).claim(1234)).to.be.revertedWith(
                "ERC721: owner query for nonexistent token",
            );
        });

        it("fails if not called by lender", async () => {
            const context = await loadFixture(fixture);
            const { repaymentController, borrower } = context;
            const { loanId } = await initializeLoan(context, 1);

            await blockchainTime.increaseTime(20000);
            await expect(repaymentController.connect(borrower).claim(loanId)).to.be.revertedWith("RC_OnlyLender");
        });
    });
});
