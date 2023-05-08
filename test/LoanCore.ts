import { expect } from "chai";
import hre, { ethers, waffle } from "hardhat";
const { loadFixture } = waffle;
import { BigNumber, BigNumberish, Signer } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

import {
    LoanCore,
    FeeController,
    PromissoryNote,
    MockERC20,
    CallWhitelist,
    VaultFactory,
    AssetVault
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { LoanTerms, LoanState } from "./utils/types";
import { deploy } from "./utils/contracts";
import { startLoan } from "./utils/loans";
import { ZERO_ADDRESS } from "./utils/erc20";
import { Test } from "mocha";

const ORIGINATOR_ROLE = "0x59abfac6520ec36a6556b2a4dd949cc40007459bcd5cd2507f1e5cc77b6bc97e";
const REPAYER_ROLE = "0x9c60024347074fd9de2c1e36003080d22dbc76a41ef87444d21e361bcb39118e";
const CLAIM_FEES_ROLE = "0x8dd046eb6fe22791cf064df41dbfc76ef240a563550f519aac88255bd8c2d3bb";

interface TestContext {
    loanCore: LoanCore;
    feeController: FeeController;
    vaultFactory: VaultFactory;
    mockERC20: MockERC20;
    mockBorrowerNote: PromissoryNote;
    mockLenderNote: PromissoryNote;
    borrower: SignerWithAddress;
    lender: SignerWithAddress;
    admin: SignerWithAddress;
    user: SignerWithAddress;
    other: SignerWithAddress;
    signers: Signer[];
    currentTimestamp: number;
    blockchainTime: BlockchainTime;
}

describe("LoanCore", () => {
    /**
     * Sets up a test asset vault for the user passed as an arg
     */
    const initializeBundle = async (user: Signer): Promise<BigNumber> => {
        const { vaultFactory } = await loadFixture(fixture);
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

    const createVault = async (factory: VaultFactory, to: Signer): Promise<AssetVault> => {
        const tx = await factory.initializeBundle(await to.getAddress());
        const receipt = await tx.wait();

        let vault: AssetVault | undefined;
        if (receipt && receipt.events) {
            for (const event of receipt.events) {
                if (event.args && event.args.vault) {
                    vault = <AssetVault>await ethers.getContractAt("AssetVault", event.args.vault);
                }
            }
        } else {
            throw new Error("Unable to create new vault");
        }
        if (!vault) {
            throw new Error("Unable to create new vault");
        }
        return vault;
    };

    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const blockchainTime = new BlockchainTime();
        const currentTimestamp = await blockchainTime.secondsFromNow(0);
        const signers: SignerWithAddress[] = await ethers.getSigners();
        const [borrower, lender, admin] = signers;

        const whitelist = <CallWhitelist>await deploy("CallWhitelist", signers[0], []);
        const vaultTemplate = <AssetVault>await deploy("AssetVault", signers[0], []);
        const feeController = <FeeController>await deploy("FeeController", signers[0], []);

        const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address]);

        const mockBorrowerNote = <PromissoryNote>(
            await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN"])
        );
        const mockLenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN"]);

        const originator = signers[0];
        const repayer = signers[0];

        const loanCore = <LoanCore>await deploy(
            "LoanCore",
            signers[0],
            [mockBorrowerNote.address, mockLenderNote.address]
        );

        // Grant correct permissions for promissory note
        for (const note of [mockBorrowerNote, mockLenderNote]) {
            await note.connect(admin).initialize(loanCore.address);
        }

        await loanCore.connect(signers[0]).grantRole(ORIGINATOR_ROLE, await originator.getAddress());
        await loanCore.connect(signers[0]).grantRole(REPAYER_ROLE, await repayer.getAddress());

        const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);

        return {
            loanCore,
            feeController,
            mockBorrowerNote,
            mockLenderNote,
            vaultFactory,
            mockERC20,
            borrower,
            lender,
            admin,
            user: signers[0],
            other: signers[1],
            signers: signers.slice(2),
            currentTimestamp,
            blockchainTime,
        };
    };

    /**
     * Create a legacy loan type object using the given parameters, or defaults
     */
    const createLoanTerms = (
        payableCurrency: string,
        collateralAddress: string,
        {
            durationSecs = BigNumber.from(360000),
            principal = ethers.utils.parseEther("100"),
            proratedInterestRate = ethers.utils.parseEther("1"),
            collateralId = 1,
            deadline = 259200,
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
        };
    };

    describe("Deployment", () => {
        it("should not allow initialization with an invalid borrower note", async () => {
            const { mockLenderNote } = await loadFixture(fixture);
            const LoanCoreFactory = await ethers.getContractFactory("LoanCore");

            await expect(
                LoanCoreFactory.deploy(ZERO_ADDRESS, mockLenderNote.address)
            ).to.be.revertedWith("LC_ZeroAddress");
        });

        it("should not allow initialization with an invalid lender note", async () => {
            const { mockBorrowerNote } = await loadFixture(fixture);
            const LoanCoreFactory = await ethers.getContractFactory("LoanCore");

            await expect(
                LoanCoreFactory.deploy(mockBorrowerNote.address, ZERO_ADDRESS)
            ).to.be.revertedWith("LC_ZeroAddress");
        });
    });

    describe("Start Loan", () => {
        interface StartLoanState extends TestContext {
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (context?: TestContext): Promise<StartLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);
            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            return { ...context, terms, borrower, lender };
        };

        it("should successfully start a loan", async () => {
            const {
                mockLenderNote,
                mockBorrowerNote,
                vaultFactory,
                feeController,
                loanCore,
                mockERC20,
                terms,
                borrower,
                lender,
                user,
            } = await setupLoan();
            const { collateralId, principal } = terms;

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            const fee = principal.mul(5).div(1000);
            await feeController.set(await feeController.FL_02(), 50);

            const loanId = await startLoan(
                loanCore,
                user,
                lender.address,
                borrower.address,
                terms,
                principal,
                principal.sub(fee)
            );


            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(principal.sub(fee));
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.equal(fee);

            const storedLoanData = await loanCore.getLoan(loanId);
            expect(storedLoanData.state).to.equal(LoanState.Active);
            expect(await mockLenderNote.ownerOf(loanId)).to.equal(lender.address);
            expect(await mockBorrowerNote.ownerOf(loanId)).to.equal(borrower.address);
        });

        it("should successfully settle with a fee", async () => {
            const { mockLenderNote, mockBorrowerNote, vaultFactory, loanCore, mockERC20, terms, borrower, lender } =
                await setupLoan();
            const { collateralId, principal } = terms;

            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            const fee = principal.mul(1).div(100);

            const loanId = await startLoan(
                loanCore,
                borrower,
                lender.address,
                borrower.address,
                terms,
                principal,
                principal.sub(fee)
            );

            // ensure the 1% fee was used
            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(principal.sub(fee));
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.equal(fee);

            const storedLoanData = await loanCore.getLoan(loanId);
            expect(storedLoanData.state).to.equal(LoanState.Active);
            expect(await mockLenderNote.ownerOf(loanId)).to.equal(lender.address);
            expect(await mockBorrowerNote.ownerOf(loanId)).to.equal(borrower.address);
        });

        it("should successfully start two loans back to back", async () => {
            const context = await loadFixture(fixture);
            const { vaultFactory, loanCore, mockERC20 } = context;
            let { terms, borrower, lender } = await setupLoan(context);
            let { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, lender.address, borrower.address, terms, principal, principal);

            ({ terms, borrower, lender } = await setupLoan(context));
            ({ collateralId, principal } = terms);

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, lender.address, borrower.address, terms, principal, principal);
        });

        it("should fail to start two loans where principal for both is paid at once", async () => {
            const context = await loadFixture(fixture);
            const { vaultFactory, loanCore, mockERC20 } = context;
            let { terms, borrower, lender } = await setupLoan(context);
            let { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, lender.address, borrower.address, terms, principal, principal);

            ({ terms, borrower, lender } = await setupLoan(context));
            ({ collateralId, principal } = terms);

            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            // fails because the full input from the first loan was factored into the stored contract balance
            await expect(
                loanCore.connect(borrower).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
                    ethers.constants.HashZero,
                    principal,
                    principal
                )
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
        });

        it("rejects calls from non-originator", async () => {
            const { loanCore, user: borrower, other: lender, terms } = await setupLoan();

            await expect(
                loanCore.connect(lender).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
                    ethers.constants.HashZero,
                    terms.principal,
                    terms.principal,
                )
            ).to.be.revertedWith(
                `AccessControl: account ${(
                    lender.address
                ).toLowerCase()} is missing role ${ORIGINATOR_ROLE}`,
            );
        });

        it("should fail to start a loan that is already started", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            await loanCore.connect(borrower).startLoan(
                lender.address,
                borrower.address,
                terms,
                ethers.constants.HashZero,
                terms.principal,
                terms.principal
            );

            await expect(
                loanCore.connect(borrower).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
                    ethers.constants.HashZero,
                    terms.principal,
                    terms.principal
                ),
            ).to.be.revertedWith("LC_CollateralInUse");
        });

        it("should fail to start a loan that is repaid", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal, proratedInterestRate } = terms;


            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);
            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                lender.address,
                borrower.address,
                terms,
                principal,
                principal
            );

            const repayAmount = principal.add(proratedInterestRate);
            await mockERC20.connect(borrower).mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount);

            // Originator no longer owns collateral
            await expect(
                loanCore.connect(borrower).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
                    ethers.constants.HashZero,
                    principal,
                    principal
                ),
            ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
        });

        it("should fail to start a loan that is already claimed", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender, blockchainTime } = await setupLoan();
            const { collateralId, principal, proratedInterestRate } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                lender.address,
                borrower.address,
                terms,
                principal,
                principal
            );

            await mockERC20.connect(borrower).mint(loanCore.address, principal.add(proratedInterestRate));

            await blockchainTime.increaseTime(360001);

            await loanCore.connect(borrower).claim(loanId, 0);
            await expect(
                loanCore.connect(borrower).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
                    ethers.constants.HashZero,
                    principal,
                    principal
                ),
            ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
        });

        it("should fail to start a loan if collateral has not been sent", async () => {
            const { loanCore, terms, borrower, lender } = await setupLoan();

            await expect(
                loanCore.connect(borrower).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
                    ethers.constants.HashZero,
                    terms.principal,
                    terms.principal
                ),
            ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
        });

        it("should fail to start a loan if lender did not deposit", async () => {
            const { vaultFactory, loanCore, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;
            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await expect(
                loanCore.connect(borrower).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
                    ethers.constants.HashZero,
                    principal,
                    principal
                ),
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
        });

        it("should fail to start a loan if lender did not deposit enough", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal.sub(1));
            await mockERC20.connect(lender).approve(loanCore.address, principal.sub(1));

            await expect(
                loanCore.connect(borrower).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
                    ethers.constants.HashZero,
                    principal,
                    principal
                ),
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
        });

        it("should fail when paused", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();

            const { collateralId, principal } = terms;

            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, loanCore.address, collateralId);
            await mockERC20.connect(lender).mint(loanCore.address, principal);

            await loanCore.connect(borrower).pause();
            await expect(
                loanCore.connect(borrower).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
                    ethers.constants.HashZero,
                    principal,
                    principal
                ),
            ).to.be.revertedWith("Pausable: paused");
        });
    });

    describe("Repay Loan", function () {
        interface RepayLoanState extends TestContext {
            loanId: BigNumberish;
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);

            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, terms.principal);
            await mockERC20.connect(lender).approve(loanCore.address, terms.principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                lender.address,
                borrower.address,
                terms,
                terms.principal,
                terms.principal
            );

            return { ...context, loanId, terms, borrower, lender };
        };

        it("should successfully repay loan", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);
            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount)).to.emit(loanCore, "LoanRepaid").withArgs(loanId);
        });

        it("rejects calls from non-repayer", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20.connect(borrower).mint(loanCore.address, repayAmount);

            await expect(loanCore.connect(other).repay(loanId, borrower.address, repayAmount, repayAmount)).to.be.revertedWith(
                `AccessControl: account ${(await other.getAddress()).toLowerCase()} is missing role ${REPAYER_ROLE}`,
            );
        });

        it("should update repayer address and work with new one", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);

            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);
            await loanCore.grantRole(REPAYER_ROLE, await other.getAddress());

            await expect(loanCore.connect(other).repay(loanId, borrower.address, repayAmount, repayAmount)).to.emit(loanCore, "LoanRepaid").withArgs(loanId);
        });

        it("should fail if the loan does not exist", async () => {
            const { loanCore, user: borrower } = await setupLoan();
            const loanId = "123412341324";
            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, 0, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is not active", async () => {
            const { loanCore, user: borrower, terms } = await setupLoan();
            const collateralId = await initializeBundle(borrower);
            terms.collateralId = collateralId;
            const loanId = 1000;
            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, 0, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is already repaid", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount);
            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is already claimed", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms, blockchainTime } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20.connect(borrower).mint(loanCore.address, repayAmount);
            await blockchainTime.increaseTime(360001);

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            );
        });

        it("should fail if the borrower cannot cover debt", async () => {
            const { loanId, loanCore, user: borrower, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            );
        });

        it("should fail if the borrower cannot cover debt in full", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20.connect(borrower).mint(loanCore.address, repayAmount.sub(1));

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            );
        });

        it("should fail if the borrower cannot cover interest in full", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20.connect(borrower).mint(loanCore.address, repayAmount.sub(1));

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            );
        });

        it("should still work when paused", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);
            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount)).to.emit(loanCore, "LoanRepaid").withArgs(loanId);
        });
    });

    describe("Claim loan", async function () {
        interface RepayLoanState extends TestContext {
            loanId: BigNumberish;
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);

            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, terms.principal);
            await mockERC20.connect(lender).approve(loanCore.address, terms.principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                lender.address,
                borrower.address,
                terms,
                terms.principal,
                terms.principal
            );

            return { ...context, loanId, terms, borrower, lender };
        };

        it("should successfully claim loan", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms, blockchainTime } = await setupLoan();

            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.proratedInterestRate));

            await blockchainTime.increaseTime(360001);

            await expect(loanCore.connect(borrower).claim(loanId, 0))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);
        });

        it("Rejects calls from non-repayer", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other, terms, blockchainTime } = await setupLoan();

            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.proratedInterestRate));
            await blockchainTime.increaseTime(360001);

            await expect(loanCore.connect(other).claim(loanId, 0)).to.be.revertedWith(
                `AccessControl: account ${(await other.getAddress()).toLowerCase()} is missing role ${REPAYER_ROLE}`,
            );
        });

        it("should fail if loan doesnt exist", async () => {
            const { loanCore, user: borrower } = await setupLoan();
            const loanId = "123412341324";
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is not active", async () => {
            const { loanCore, user: borrower, terms } = await setupLoan();
            const collateralId = await initializeBundle(borrower);
            terms.collateralId = collateralId;
            const loanId = 100;
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is already repaid", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount);
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is already claimed", async () => {
            const { loanId, loanCore, user: borrower, blockchainTime } = await setupLoan();

            await blockchainTime.increaseTime(360001);

            await loanCore.connect(borrower).claim(loanId, 0);
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is not expired", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.proratedInterestRate));

            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith(
                "LC_NotExpired",
            );
        });

        it("should fail when paused", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms, blockchainTime } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.proratedInterestRate));

            await blockchainTime.increaseTime(360001);

            await loanCore.connect(borrower).pause();
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith(
                "Pausable: paused",
            );
        });

        it("pause, unPause, make tx", async () => {
            const {
                mockERC20,
                loanId,
                loanCore,
                user: borrower,
                terms,
                blockchainTime,
            } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.proratedInterestRate));

            await blockchainTime.increaseTime(360001);
            await loanCore.connect(borrower).pause();

            await blockchainTime.increaseTime(100);
            await loanCore.connect(borrower).unpause();

            await expect(loanCore.connect(borrower).claim(loanId, 0))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);
        });
    });

    describe("Claim fees", async () => {
        interface StartLoanState extends TestContext {
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (context?: TestContext): Promise<StartLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);

            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            return { ...context, terms, borrower, lender };
        };

        it("should successfully claim fees", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            const fee = principal.mul(5).div(1000);
            await startLoan(loanCore, borrower, lender.address, borrower.address, terms, principal, principal.sub(fee));


            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(fee);
            await expect(loanCore.connect(borrower).withdrawProtocolFees(mockERC20.address, borrower.address))
                .to.emit(loanCore, "FundsWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, fee);
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(0);
        });

        it("should fail for anyone other than the admin", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            const fee = principal.mul(5).div(1000);
            await startLoan(loanCore, borrower, lender.address, borrower.address, terms, principal, principal.sub(fee));

            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(fee);

            await expect(loanCore.connect(lender).withdrawProtocolFees(mockERC20.address, borrower.address)).to.be.revertedWith(
                `AccessControl: account ${(
                    lender.address
                ).toLowerCase()} is missing role ${CLAIM_FEES_ROLE}`,
            );
        });

        it("only fee claimer should be able to change fee claimer", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, principal);
            await mockERC20.connect(lender).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, lender.address, borrower.address, terms, principal, principal);

            await loanCore.connect(borrower).grantRole(CLAIM_FEES_ROLE, lender.address);
            await loanCore.connect(borrower).revokeRole(CLAIM_FEES_ROLE, borrower.address);
            await expect(
                loanCore.connect(borrower).grantRole(CLAIM_FEES_ROLE, borrower.address),
            ).to.be.revertedWith(
                `AccessControl: account ${(
                    borrower.address
                ).toLowerCase()} is missing role ${CLAIM_FEES_ROLE}`,
            );
        });
    });

    describe("canCallOn", function () {
        interface StartLoanState extends TestContext {
            loanId: BigNumberish;
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (): Promise<StartLoanState> => {
            const context = await loadFixture(fixture);

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);
            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            await vaultFactory
                .connect(borrower)
                .transferFrom(borrower.address, borrower.address, collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await createVault(vaultFactory, borrower);

            await mockERC20.connect(lender).mint(lender.address, terms.principal);
            await mockERC20.connect(lender).approve(loanCore.address, terms.principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                lender.address,
                borrower.address,
                terms,
                terms.principal,
                terms.principal
            );

            return { ...context, loanId, terms, borrower, lender };
        };

        it("should return true for borrower on vault in use as collateral", async () => {
            const {
                loanCore,
                loanId,
                borrower,
                terms: { collateralId },
            } = await setupLoan();

            const storedLoanData = await loanCore.getLoan(loanId);
            expect(storedLoanData.state).to.equal(LoanState.Active);

            expect(await loanCore.canCallOn(borrower.address, collateralId.toString())).to.be.true;
        });

        it("should return true for any vaults if borrower has several", async () => {
            const context = await loadFixture(fixture);

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);
            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, terms.principal);
            await mockERC20.connect(lender).approve(loanCore.address, terms.principal);

            await startLoan(loanCore, borrower, lender.address, borrower.address, terms, terms.principal, terms.principal);

            const collateralId2 = await initializeBundle(borrower);
            const terms2 = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: collateralId2 });

            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId2);

            await mockERC20.connect(lender).mint(lender.address, terms2.principal);
            await mockERC20.connect(lender).approve(loanCore.address, terms2.principal);

            await startLoan(loanCore, borrower, lender.address, borrower.address, terms2, terms2.principal, terms2.principal);

            expect(await loanCore.canCallOn(borrower.address, collateralId.toString())).to.be.true;
            expect(await loanCore.canCallOn(borrower.address, collateralId2.toString())).to.be.true;
        });

        it("should return false for irrelevant user and vault", async () => {
            const context = await loadFixture(fixture);

            const { vaultFactory, loanCore, user: borrower, signers } = context;
            const collateralId = await initializeBundle(borrower);

            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            expect(await loanCore.canCallOn(await signers[2].getAddress(), collateralId.toString())).to.be.false;
        });

        it("should return false for irrelevant user on vault in use as collateral", async () => {
            const {
                loanCore,
                signers,
                terms: { collateralId },
            } = await setupLoan();

            expect(await loanCore.canCallOn(await signers[2].getAddress(), collateralId.toString())).to.be.false;
        });

        it("should return false for lender user on vault in use as collateral", async () => {
            const {
                loanCore,
                loanId,
                lender,
                terms: { collateralId },
            } = await setupLoan();

            const storedLoanData = await loanCore.getLoan(loanId);
            expect(storedLoanData.state).to.equal(LoanState.Active);

            expect(await loanCore.canCallOn(lender.address, collateralId.toString())).to.be.false;
        });
    });

    describe("Nonce management", () => {
        let context: TestContext;

        beforeEach(async () => {
            context = await loadFixture(fixture);
        });

        it("does not let a nonce be consumed by a non-originator", async () => {
            const { loanCore, other, user } = context;
            await expect(loanCore.connect(other).consumeNonce(await user.getAddress(), 10)).to.be.revertedWith(
                `AccessControl: account ${await (
                    await other.getAddress()
                ).toLocaleLowerCase()} is missing role ${ORIGINATOR_ROLE}`,
            );
        });

        it("consumes a nonce", async () => {
            const { loanCore, user } = context;

            await expect(loanCore.connect(user).consumeNonce(user.address, 10)).to.not.be.reverted;

            expect(await loanCore.isNonceUsed(user.address, 10)).to.be.true;
            expect(await loanCore.isNonceUsed(user.address, 20)).to.be.false;
        });

        it("reverts if attempting to use a nonce that has already been consumed", async () => {
            const { loanCore, user } = context;

            await expect(loanCore.connect(user).consumeNonce(user.address, 10)).to.not.be.reverted;

            await expect(loanCore.connect(user).consumeNonce(user.address, 10)).to.be.revertedWith("LC_NonceUsed");
        });

        it("cancels a nonce", async () => {
            const { loanCore, user } = context;

            await expect(loanCore.connect(user).cancelNonce(10)).to.not.be.reverted;

            expect(await loanCore.isNonceUsed(user.address, 10)).to.be.true;
            expect(await loanCore.isNonceUsed(user.address, 20)).to.be.false;
        });

        it("reverts if attempting to use a nonce that has already been cancelled", async () => {
            const { loanCore, user } = context;

            await expect(loanCore.connect(user).cancelNonce(10)).to.not.be.reverted;

            await expect(loanCore.connect(user).consumeNonce(user.address, 10)).to.be.revertedWith("LC_NonceUsed");
        });
    });
});
