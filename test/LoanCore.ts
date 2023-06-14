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
    AssetVault,
    BaseURIDescriptor
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { LoanTerms, LoanState } from "./utils/types";
import { deploy } from "./utils/contracts";
import { startLoan } from "./utils/loans";
import { ZERO_ADDRESS } from "./utils/erc20";

import {
    ORIGINATOR_ROLE,
    REPAYER_ROLE,
    FEE_CLAIMER_ROLE,
    AFFILIATE_MANAGER_ROLE,
    ADMIN_ROLE,
    BASE_URI
} from "./utils/constants";

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
    signers: SignerWithAddress[];
    currentTimestamp: number;
    blockchainTime: BlockchainTime;
}

interface StartLoanState extends TestContext {
    terms: LoanTerms;
    borrower: SignerWithAddress;
    lender: SignerWithAddress;
}

interface RepayLoanState extends TestContext {
    loanId: BigNumberish;
    terms: LoanTerms;
    borrower: SignerWithAddress;
    lender: SignerWithAddress;
}

const blockchainTime = new BlockchainTime();

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

const createVault = async (factory: VaultFactory, to: SignerWithAddress): Promise<AssetVault> => {
    const tx = await factory.initializeBundle(to.address);
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
    const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI])
    const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address]);

    const mockBorrowerNote = <PromissoryNote>(
        await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN", descriptor.address])
    );
    const mockLenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN", descriptor.address]);

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

    await loanCore.connect(signers[0]).grantRole(FEE_CLAIMER_ROLE, signers[0].address);
    await loanCore.connect(signers[0]).grantRole(AFFILIATE_MANAGER_ROLE, signers[0].address);
    await loanCore.connect(signers[0]).grantRole(ORIGINATOR_ROLE, originator.address);
    await loanCore.connect(signers[0]).grantRole(REPAYER_ROLE, repayer.address);

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
        affiliateCode = ethers.constants.HashZero
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
        affiliateCode
    };
};

describe("LoanCore", () => {
    describe("Deployment", () => {
        it("should not allow initialization with an invalid borrower note", async () => {
            const { mockLenderNote } = await loadFixture(fixture);
            const LoanCoreFactory = await ethers.getContractFactory("LoanCore");

            await expect(LoanCoreFactory.deploy(ZERO_ADDRESS, mockLenderNote.address)).to.be.revertedWith(
                `LC_ZeroAddress("borrowerNote")`
            );
        });

        it("should not allow initialization with an invalid lender note", async () => {
            const { mockBorrowerNote } = await loadFixture(fixture);
            const LoanCoreFactory = await ethers.getContractFactory("LoanCore");

            await expect(LoanCoreFactory.deploy(mockBorrowerNote.address, ZERO_ADDRESS)).to.be.revertedWith(
                `LC_ZeroAddress("lenderNote")`
            );
        });

        it("should not allow initialization using the same note twice", async () => {
            const { mockBorrowerNote } = await loadFixture(fixture);
            const LoanCoreFactory = await ethers.getContractFactory("LoanCore");

            await expect(
                LoanCoreFactory.deploy(mockBorrowerNote.address, mockBorrowerNote.address)
            ).to.be.revertedWith("LC_ReusedNote");
        });
    });

    describe("Start Loan", () => {
        const setupLoan = async (context?: TestContext): Promise<StartLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(vaultFactory, borrower);
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

        it("should fail to start a loan where a higher principal is paid than received", async () => {
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
                    principal,
                    principal.add(ethers.utils.parseEther("1")) // borrower receives extra principal
                )
            ).to.be.revertedWith("LC_CannotSettle");
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
                terms.principal,
                terms.principal
            );

            await expect(
                loanCore.connect(borrower).startLoan(
                    lender.address,
                    borrower.address,
                    terms,
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
                    principal,
                    principal
                ),
            ).to.be.revertedWith("Pausable: paused");
        });
    });

    describe("Repay Loan", () => {
        const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(vaultFactory, borrower);

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
                `AccessControl: account ${(other.address).toLowerCase()} is missing role ${REPAYER_ROLE}`,
            );
        });

        it("should update repayer address and work with new one", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);

            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);
            await loanCore.grantRole(REPAYER_ROLE, other.address);

            await expect(loanCore.connect(other).repay(loanId, borrower.address, repayAmount, repayAmount)).to.emit(loanCore, "LoanRepaid").withArgs(loanId);
        });

        it("should fail if the loan does not exist", async () => {
            const { loanCore, user: borrower } = await setupLoan();
            const loanId = "123412341324";
            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, 0, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is not active", async () => {
            const { loanCore, vaultFactory, user: borrower, terms } = await setupLoan();
            const collateralId = await initializeBundle(vaultFactory, borrower);
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

        it("should fail if asked to pay out more than received", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);
            const amountToLender = repayAmount.add(ethers.utils.parseEther("1"));

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, amountToLender))
                .to.be.revertedWith("LC_CannotSettle");
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

    describe("ForceRepay Loan", () => {
        const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(vaultFactory, borrower);

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

        it("should successfully forceRepay (2 step repay) a loan", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms, mockLenderNote } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            // Add lender to the mockERC20 blacklist so it forces the lender to call redeemNote
            await mockERC20.setBlacklisted(lender.address, true);

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount))
                .to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            // Unlike repay, lender note should still exist
            expect(await mockLenderNote.ownerOf(loanId)).to.equal(lender.address);

            // Note receipt should exist
            const receipt = await loanCore.getNoteReceipt(loanId);
            expect(receipt).to.not.be.undefined;
            expect(receipt[0]).to.eq(mockERC20.address);
            expect(receipt[1]).to.eq(repayAmount);
        });

        it("rejects calls from non-repayer", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20.connect(borrower).mint(loanCore.address, repayAmount);

            await expect(loanCore.connect(other).repay(loanId, borrower.address, repayAmount, repayAmount)).to.be.revertedWith(
                `AccessControl: account ${(other.address).toLowerCase()} is missing role ${REPAYER_ROLE}`,
            );
        });

        it("should update repayer address and work with new one", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);

            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);
            await loanCore.grantRole(REPAYER_ROLE, other.address);

            await expect(loanCore.connect(other).repay(loanId, borrower.address, repayAmount, repayAmount)).to.emit(loanCore, "LoanRepaid").withArgs(loanId);
        });

        it("should fail if the loan does not exist", async () => {
            const { loanCore, user: borrower } = await setupLoan();
            const loanId = "123412341324";
            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, 0, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is not active", async () => {
            const { loanCore, user: borrower, terms, vaultFactory } = await setupLoan();
            const collateralId = await initializeBundle(vaultFactory, borrower);
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

        it("should fail if asked to pay out more than received", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);
            const amountToLender = repayAmount.add(ethers.utils.parseEther("1"));

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, amountToLender))
                .to.be.revertedWith("LC_CannotSettle");
        });

        it("should still work when paused", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            // Add lender to the mockERC20 blacklist so it forces the lender to call redeemNote
            await mockERC20.setBlacklisted(lender.address, true);

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount))
                .to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);
        });
    });

    describe("Claim loan", () => {
        const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(vaultFactory, borrower);

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
                `AccessControl: account ${(other.address).toLowerCase()} is missing role ${REPAYER_ROLE}`,
            );
        });

        it("should fail if loan doesnt exist", async () => {
            const { loanCore, user: borrower } = await setupLoan();
            const loanId = "123412341324";
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is not active", async () => {
            const { loanCore, user: borrower, terms, vaultFactory } = await setupLoan();
            const collateralId = await initializeBundle(vaultFactory, borrower);
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

    describe("Redeem note", () => {
        const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(vaultFactory, borrower);

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

            // Force repay the loan
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            // Add lender to the mockERC20 blacklist so it forces the lender to call redeemNote
            await mockERC20.setBlacklisted(lender.address, true);

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount))
                .to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "ForceRepay").withArgs(loanId);

            const receipt = await loanCore.noteReceipts(loanId);
            expect(receipt).to.not.be.undefined;
            expect(receipt[0]).to.eq(mockERC20.address);
            expect(receipt[1]).to.eq(repayAmount);

            return { ...context, loanId, terms, borrower, lender };
        };

        it("should successfully redeem a note, burning the lender note", async () => {
            const { loanCore, mockERC20, loanId, borrower, lender, terms, mockLenderNote } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            await expect(loanCore.connect(borrower).redeemNote(loanId, 0, borrower.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, borrower.address, loanId, repayAmount)
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, borrower.address, repayAmount);

            // Make sure lender note burned
            await expect(mockLenderNote.ownerOf(loanId)).to.be.revertedWith("ERC721: owner query for nonexistent token");

            // Make sure receipt is zero'd out
            const receipt = await loanCore.noteReceipts(loanId);
            expect(receipt).to.not.be.undefined;
            expect(receipt[0]).to.eq(ZERO_ADDRESS);
            expect(receipt[1]).to.eq(0);
        });

        it("not redeem a note that does not exist", async () => {
            const { loanCore, loanId, borrower, lender } = await setupLoan();
            const badLoanId = BigNumber.from(loanId).mul(10);

            // Make sure receipt is zero'd out
            const receipt = await loanCore.noteReceipts(badLoanId);
            expect(receipt).to.not.be.undefined;
            expect(receipt[0]).to.eq(ZERO_ADDRESS);
            expect(receipt[1]).to.eq(0);

            await expect(loanCore.connect(borrower).redeemNote(badLoanId, 0, lender.address))
                .to.be.revertedWith("LC_NoReceipt");;
        });

        it("should distribute fees from a redeemed note", async () => {
            const { loanCore, mockERC20, loanId, borrower, lender, terms, mockLenderNote, feeController } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Set a redeem fee of 10%
            await feeController.set(await feeController.FL_09(), 10_00);

            await expect(loanCore.connect(borrower).redeemNote(loanId, repayAmount.div(10), borrower.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, borrower.address, loanId, repayAmount.div(10).mul(9))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, borrower.address, repayAmount.div(10).mul(9));

            // Make sure lender note burned
            await expect(mockLenderNote.ownerOf(loanId)).to.be.revertedWith("ERC721: owner query for nonexistent token");

            // Make sure receipt is zero'd out
            const receipt = await loanCore.noteReceipts(loanId);
            expect(receipt).to.not.be.undefined;
            expect(receipt[0]).to.eq(ZERO_ADDRESS);
            expect(receipt[1]).to.eq(0);

            // Check protocol fees available for withdrawal
            expect(await loanCore.feesWithdrawable(mockERC20.address, loanCore.address))
                .to.eq(repayAmount.div(10));

            await expect(loanCore.connect(borrower).withdrawProtocolFees(mockERC20.address, borrower.address))
                .to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, repayAmount.div(10));
        });

        it("reverts if withdrawProtocolFees() is called to address zero", async () => {
            const { loanCore, mockERC20, loanId, borrower, lender, terms, mockLenderNote, feeController } =
                await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Set a redeem fee of 10%
            await feeController.set(await feeController.FL_09(), 10_00);

            await expect(loanCore.connect(borrower).redeemNote(loanId, repayAmount.div(10), lender.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, lender.address, loanId, repayAmount.div(10).mul(9))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, repayAmount.div(10).mul(9));

            // Make sure lender note burned
            await expect(mockLenderNote.ownerOf(loanId)).to.be.revertedWith(
                "ERC721: owner query for nonexistent token",
            );

            // Make sure receipt is zero'd out
            const receipt = await loanCore.noteReceipts(loanId);
            expect(receipt).to.not.be.undefined;
            expect(receipt[0]).to.eq(ZERO_ADDRESS);
            expect(receipt[1]).to.eq(0);

            // Check protocol fees available for withdrawal
            expect(await loanCore.feesWithdrawable(mockERC20.address, loanCore.address)).to.eq(repayAmount.div(10));

            await expect(
                loanCore.connect(borrower).withdrawProtocolFees(mockERC20.address, ethers.constants.AddressZero),
            ).to.be.revertedWith(`LC_ZeroAddress("to")`);
        });

        it("reverts if withdrawProtocolFees() is called on token address zero", async () => {
            const { loanCore, mockERC20, loanId, borrower, lender, terms, mockLenderNote, feeController } =
                await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Set a redeem fee of 10%
            await feeController.set(await feeController.FL_09(), 10_00);

            await expect(loanCore.connect(borrower).redeemNote(loanId, repayAmount.div(10), lender.address))
                .to.emit(loanCore, "NoteRedeemed")
                .withArgs(mockERC20.address, lender.address, lender.address, loanId, repayAmount.div(10).mul(9))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, lender.address, repayAmount.div(10).mul(9));

            // Make sure lender note burned
            await expect(mockLenderNote.ownerOf(loanId)).to.be.revertedWith(
                "ERC721: owner query for nonexistent token",
            );

            // Make sure receipt is zero'd out
            const receipt = await loanCore.noteReceipts(loanId);
            expect(receipt).to.not.be.undefined;
            expect(receipt[0]).to.eq(ZERO_ADDRESS);
            expect(receipt[1]).to.eq(0);

            // Check protocol fees available for withdrawal
            expect(await loanCore.feesWithdrawable(mockERC20.address, loanCore.address)).to.eq(repayAmount.div(10));

            await expect(
                loanCore.connect(borrower).withdrawProtocolFees(ethers.constants.AddressZero, borrower.address),
            ).to.be.revertedWith(`LC_ZeroAddress("token")`);
        });
    });

    describe("Claim fees", () => {
        const setupLoan = async (context?: TestContext): Promise<StartLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(vaultFactory, borrower);

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
                .to.emit(loanCore, "FeesWithdrawn")
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
                ).toLowerCase()} is missing role ${FEE_CLAIMER_ROLE}`,
            );
        });

        it("only admin should be able to change fee claimer", async () => {
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

            await loanCore.connect(borrower).grantRole(FEE_CLAIMER_ROLE, lender.address);
            await loanCore.connect(borrower).revokeRole(FEE_CLAIMER_ROLE, borrower.address);
            await expect(
                loanCore.connect(lender).grantRole(FEE_CLAIMER_ROLE, borrower.address),
            ).to.be.revertedWith(
                `AccessControl: account ${(
                    lender.address
                ).toLowerCase()} is missing role ${ADMIN_ROLE}`,
            );
        });

        it("only admin should be able to change fee claimer", async () => {
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

            await loanCore.connect(borrower).grantRole(FEE_CLAIMER_ROLE, lender.address);
            await loanCore.connect(borrower).revokeRole(FEE_CLAIMER_ROLE, borrower.address);
            await expect(
                loanCore.connect(lender).grantRole(FEE_CLAIMER_ROLE, borrower.address),
            ).to.be.revertedWith(
                `AccessControl: account ${(
                    lender.address
                ).toLowerCase()} is missing role ${ADMIN_ROLE}`,
            );
        });

        it("only admin should be able to change affiliate manager", async () => {
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

            await loanCore.connect(borrower).grantRole(AFFILIATE_MANAGER_ROLE, lender.address);
            await loanCore.connect(borrower).revokeRole(AFFILIATE_MANAGER_ROLE, borrower.address);
            await expect(
                loanCore.connect(lender).grantRole(AFFILIATE_MANAGER_ROLE, borrower.address),
            ).to.be.revertedWith(
                `AccessControl: account ${(
                    lender.address
                ).toLowerCase()} is missing role ${ADMIN_ROLE}`,
            );
        });
    });

    describe("Rollovers", () => {
        const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
            context = <TestContext>(context || (await loadFixture(fixture)));

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(vaultFactory, borrower);

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

        it("should successfully roll over loan", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("12"));

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            const newLoanId = BigNumber.from(loanId).add(1);

            await expect(
                loanCore.connect(borrower).rollover(
                    loanId,
                    borrower.address,
                    lender.address,
                    terms,
                    repayAmount,
                    0,
                    0,
                    repayAmount
                )
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "LoanStarted").withArgs(newLoanId, lender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver").withArgs(loanId, newLoanId);
        });

        it("rejects calls from non-originator", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("12"));

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await expect(
                loanCore.connect(lender).rollover(
                    loanId,
                    borrower.address,
                    lender.address,
                    terms,
                    repayAmount,
                    0,
                    0,
                    repayAmount
                )
            ).to.be.revertedWith("AccessControl");
        });

        it("should update originator address and work with new one, collecting funds from originator", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("12"));

            await mockERC20
                .connect(borrower)
                .mint(lender.address, repayAmount);
            await mockERC20.connect(lender).approve(loanCore.address, repayAmount);

            await loanCore.grantRole(ORIGINATOR_ROLE, lender.address);

            const newLoanId = BigNumber.from(loanId).add(1);

            await expect(
                loanCore.connect(lender).rollover(
                    loanId,
                    borrower.address,
                    lender.address,
                    terms,
                    repayAmount,
                    0,
                    0,
                    repayAmount
                )
            ).to.emit(loanCore, "LoanRepaid").withArgs(loanId)
                .to.emit(loanCore, "LoanStarted").withArgs(newLoanId, lender.address, borrower.address)
                .to.emit(loanCore, "LoanRolledOver").withArgs(loanId, newLoanId);
        });

        it("rollover should fail if the loan is not active", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("12"));

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            const wrongLoanId = BigNumber.from(loanId).add(1);

            await expect(
                loanCore.connect(borrower).rollover(
                    wrongLoanId,
                    borrower.address,
                    lender.address,
                    terms,
                    repayAmount,
                    0,
                    0,
                    repayAmount
                )
            ).to.be.revertedWith("LC_InvalidState");
        });

        it("rollover should fail if the loan is already repaid", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("12"));

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await expect(loanCore.connect(borrower).repay(loanId, borrower.address, repayAmount, repayAmount)).to.emit(loanCore, "LoanRepaid").withArgs(loanId);

            await expect(
                loanCore.connect(borrower).rollover(
                    loanId,
                    borrower.address,
                    lender.address,
                    terms,
                    repayAmount,
                    0,
                    0,
                    repayAmount
                )
            ).to.be.revertedWith("LC_InvalidState");
        });

        it("rollover should fail if the loan is already claimed", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Figure out amounts owed
            // With same terms, borrower will have to pay interest plus 0.1%
            // 10% interest on 100, plus 0.1% eq 11.1

            await mockERC20.mint(borrower.address, ethers.utils.parseEther("12"));
            await mockERC20.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("12"));

            await mockERC20
                .connect(borrower)
                .mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await blockchainTime.increaseTime(360001);

            await expect(loanCore.connect(borrower).claim(loanId, 0))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);

            await expect(
                loanCore.connect(borrower).rollover(
                    loanId,
                    borrower.address,
                    lender.address,
                    terms,
                    repayAmount,
                    0,
                    0,
                    repayAmount
                )
            ).to.be.revertedWith("LC_InvalidState");
        });

        it("rollover should fail if the originator does not approve settled amount", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Mint enough for repayment, but do not approve
            await mockERC20.mint(borrower.address, repayAmount);

            await expect(
                loanCore.connect(borrower).rollover(
                    loanId,
                    borrower.address,
                    lender.address,
                    terms,
                    repayAmount,
                    0,
                    repayAmount,
                    0
                )
            ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
        });

        it("rollover should fail if asked to pay out more than received", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other: lender, terms } = await setupLoan();
            const repayAmount = terms.principal.add(terms.proratedInterestRate);

            // Mint enough for repayment, but do not approve
            await mockERC20.mint(borrower.address, repayAmount);
            await mockERC20.connect(borrower).approve(loanCore.address, repayAmount);

            await expect(
                loanCore.connect(borrower).rollover(
                    loanId,
                    borrower.address,
                    lender.address,
                    terms,
                    repayAmount,
                    0,
                    repayAmount,
                    repayAmount
                )
            ).to.be.revertedWith("LC_CannotSettle");
        });
    });

    describe("canCallOn", () => {
        const setupLoan = async (): Promise<RepayLoanState> => {
            const context = await loadFixture(fixture);

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(vaultFactory, borrower);
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
            const collateralId = await initializeBundle(vaultFactory, borrower);
            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(lender.address, terms.principal);
            await mockERC20.connect(lender).approve(loanCore.address, terms.principal);

            await startLoan(loanCore, borrower, lender.address, borrower.address, terms, terms.principal, terms.principal);

            const collateralId2 = await initializeBundle(vaultFactory, borrower);
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
            const collateralId = await initializeBundle(vaultFactory, borrower);

            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            expect(await loanCore.canCallOn(signers[2].address, collateralId.toString())).to.be.false;
        });

        it("should return false for irrelevant user on vault in use as collateral", async () => {
            const {
                loanCore,
                signers,
                terms: { collateralId },
            } = await setupLoan();

            expect(await loanCore.canCallOn(signers[2].address, collateralId.toString())).to.be.false;
        });

        it("should return false for a user with a different loan open", async () => {
            const {
                loanCore,
                user: borrower,
                other: lender,
                mockERC20,
                vaultFactory,
                mockBorrowerNote,
                terms: { collateralId },
            } = await setupLoan();

            // Start another loan, with counterparties switched
            // Have lender try to call on borrower's vault
            const collateralId2 = await initializeBundle(vaultFactory, lender);
            const terms2 = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: collateralId2 });

            await vaultFactory.connect(lender).approve(loanCore.address, collateralId2);
            await createVault(vaultFactory, lender);

            expect(await mockBorrowerNote.balanceOf(borrower.address)).to.eq(1);

            await mockERC20.connect(borrower).mint(borrower.address, terms2.principal);
            await mockERC20.connect(borrower).approve(loanCore.address, terms2.principal);

            expect(await mockBorrowerNote.balanceOf(borrower.address)).to.eq(1);

            await startLoan(
                loanCore,
                borrower,
                borrower.address,
                lender.address,
                terms2,
                terms2.principal,
                terms2.principal
            );

            // Borrower has a different loan as well
            expect(await mockBorrowerNote.balanceOf(lender.address)).to.eq(1);
            expect(await mockBorrowerNote.balanceOf(borrower.address)).to.eq(1);

            expect(await loanCore.canCallOn(borrower.address, collateralId.toString())).to.be.true;
            expect(await loanCore.canCallOn(lender.address, collateralId.toString())).to.be.false;
            expect(await loanCore.canCallOn(borrower.address, collateralId2.toString())).to.be.false;
            expect(await loanCore.canCallOn(lender.address, collateralId2.toString())).to.be.true;
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
            await expect(loanCore.connect(other).consumeNonce(user.address, 10)).to.be.revertedWith(
                `AccessControl: account ${await (
                    other.address
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

    describe("Affiliate fees", () => {
        let context: TestContext;

        beforeEach(async () => {
            context = await loadFixture(fixture);
        });

        describe("Setting affiliate splits", () => {
            it("does not let a non-owner set affiliate splits", async () => {
                const { loanCore, other } = context;

                const code = ethers.utils.id("FOO");
                await expect(
                    loanCore.connect(other).setAffiliateSplits([code], [{ affiliate: other.address, splitBps: 50_00 }]),
                ).to.be.revertedWith("AccessControl");
            });

            it("does not set an affiliate fee over the maximum", async () => {
                const { loanCore, other } = context;

                const code = ethers.utils.id("FOO");
                await expect(
                    loanCore.setAffiliateSplits([code], [{ affiliate: other.address, splitBps: 100_00 }]),
                ).to.be.revertedWith("LC_OverMaxSplit");
            });

            it("affiliate split argument lengths must be matched", async () => {
                const { loanCore, other } = context;

                const code = ethers.utils.id("FOO");
                const code2 = ethers.utils.id("BAR");

                await expect(
                    loanCore.setAffiliateSplits([code, code2], [{ affiliate: other.address, splitBps: 100_00 }]),
                ).to.be.revertedWith("LC_ArrayLengthMismatch");
            });

            it("sets multiple affiliate splits", async () => {
                const { loanCore, user, other } = context;

                const codes = [ethers.utils.id("FOO"), ethers.utils.id("BAR")];

                await expect(
                    loanCore.setAffiliateSplits(
                        codes,
                        [
                            { affiliate: user.address, splitBps: 20_00 },
                            { affiliate: other.address, splitBps: 10_00 },
                        ]
                    )
                )
                    .to.emit(loanCore, "AffiliateSet")
                    .withArgs(codes[0], user.address, 20_00)
                    .to.emit(loanCore, "AffiliateSet")
                    .withArgs(codes[1], other.address, 10_00);
            });

            it("does not let an affiliate code be overwritten", async () => {
                const { loanCore, user, other } = context;

                const code = ethers.utils.id("FOO");

                await expect(
                    loanCore.setAffiliateSplits([code], [{ affiliate: user.address, splitBps: 20_00 }])
                )
                    .to.emit(loanCore, "AffiliateSet")
                    .withArgs(code, user.address, 20_00)

                // Cannot change recipient
                await expect(
                    loanCore.setAffiliateSplits([code], [{ affiliate: other.address, splitBps: 20_00 }])
                ).to.be.revertedWith("LC_AffiliateCodeAlreadySet")

                // Cannot change fee, including revocation
                await expect(
                    loanCore.setAffiliateSplits([code], [{ affiliate: user.address, splitBps: 0 }])
                ).to.be.revertedWith("LC_AffiliateCodeAlreadySet")
            });
        });

        describe("Withdrawal", () => {
            let ctx: RepayLoanState;
            let fee: BigNumber;
            const affiliateCode = ethers.utils.id("FOO");

            const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
                context = <TestContext>(context || (await loadFixture(fixture)));

                const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
                const collateralId = await initializeBundle(vaultFactory, borrower);

                // Add a 1 ETH fee
                fee = ethers.utils.parseEther("1");

                // Set up an affilate code - 50% share
                await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, borrower.address);
                await loanCore.setAffiliateSplits([affiliateCode], [{ affiliate: borrower.address, splitBps: 50_00 }]);

                const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId, affiliateCode });

                // run originator controller logic inline then invoke loanCore
                // borrower is originator with originator role
                await vaultFactory
                    .connect(borrower)
                    .transferFrom(borrower.address, borrower.address, collateralId);
                await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

                await mockERC20.connect(lender).mint(lender.address, terms.principal.add(fee));
                await mockERC20.connect(lender).approve(loanCore.address, terms.principal.add(fee));

                const loanId = await startLoan(
                    loanCore,
                    borrower,
                    lender.address,
                    borrower.address,
                    terms,
                    terms.principal.add(fee),
                    terms.principal,
                );

                return  { ...context, loanId, terms, borrower, lender };
            };

            beforeEach(async () => {
                // Start a loan, assigning some fees
                ctx = await setupLoan();
            });

            it("does not let an affiliate withdraw 0", async () => {
                const { borrower, loanCore, mockERC20 } = ctx;

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address))
                    .to.eq(fee.div(2));

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, 0, borrower.address))
                    .to.be.revertedWith("LC_ZeroAmount");
            });

            it("does not let an affiliate withdraw more than they have earned", async () => {
                const { borrower, loanCore, mockERC20 } = ctx;

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address))
                    .to.eq(fee.div(2));

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, fee, borrower.address))
                    .to.be.revertedWith("LC_CannotWithdraw");
            });

            it("affiliate can withdraw fees", async () => {
                const { borrower, loanCore, mockERC20 } = ctx;

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address))
                    .to.eq(fee.div(2));

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, fee.div(2), borrower.address))
                    .to.emit(loanCore, "FeesWithdrawn")
                    .withArgs(mockERC20.address, borrower.address, borrower.address, fee.div(2))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(loanCore.address, borrower.address, fee.div(2));
            });

            it("affiliate can withdraw fees, sending to a third party", async () => {
                const { borrower, loanCore, mockERC20 } = ctx;

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address))
                    .to.eq(fee.div(2));

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, fee.div(2), borrower.address))
                    .to.emit(loanCore, "FeesWithdrawn")
                    .withArgs(mockERC20.address, borrower.address, borrower.address, fee.div(2))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(loanCore.address, borrower.address, fee.div(2));
            });

            it("does not let an affiliate withdraw the same fees twice", async () => {
                const { borrower, loanCore, mockERC20 } = ctx;

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address))
                    .to.eq(fee.div(2));

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, fee.div(2), borrower.address))
                    .to.emit(loanCore, "FeesWithdrawn")
                    .withArgs(mockERC20.address, borrower.address, borrower.address, fee.div(2))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(loanCore.address, borrower.address, fee.div(2));

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, fee.div(2), borrower.address))
                    .to.be.revertedWith("LC_CannotWithdraw");

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, 1, borrower.address))
                    .to.be.revertedWith("LC_CannotWithdraw");
            });

            it("affiliate can partially withdraw fees", async () => {
                const { borrower, loanCore, mockERC20 } = ctx;

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address))
                    .to.eq(fee.div(2));

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, fee.div(8), borrower.address))
                    .to.emit(loanCore, "FeesWithdrawn")
                    .withArgs(mockERC20.address, borrower.address, borrower.address, fee.div(8))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(loanCore.address, borrower.address, fee.div(8));

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address))
                    .to.eq(fee.div(8).mul(3));

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, fee.div(2), borrower.address))
                    .to.be.revertedWith("LC_CannotWithdraw");

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, fee.div(8).mul(3), borrower.address))
                    .to.emit(loanCore, "FeesWithdrawn")
                    .withArgs(mockERC20.address, borrower.address, borrower.address, fee.div(8).mul(3))
                    .to.emit(mockERC20, "Transfer")
                    .withArgs(loanCore.address, borrower.address, fee.div(8).mul(3));

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address))
                    .to.eq(0);

                await expect(loanCore.connect(borrower).withdraw(mockERC20.address, 1, borrower.address))
                    .to.be.revertedWith("LC_CannotWithdraw");
            });

            it("reverts if withdraw() is called to address zero", async () => {
                const { borrower, loanCore, mockERC20 } = ctx;

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address)).to.eq(fee.div(2));

                await expect(
                    loanCore.connect(borrower).withdraw(mockERC20.address, fee.div(2), ethers.constants.AddressZero),
                ).to.be.revertedWith(`LC_ZeroAddress("to")`);
            });

            it("reverts if withdraw() is called on token address zero", async () => {
                const { borrower, loanCore, mockERC20 } = ctx;

                expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address)).to.eq(fee.div(2));

                await expect(
                    loanCore.connect(borrower).withdraw(ethers.constants.AddressZero, fee.div(2), borrower.address),
                ).to.be.revertedWith(`LC_ZeroAddress("token")`);
            });
        });

    });
});
