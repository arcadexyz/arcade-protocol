import chai, { expect } from "chai";
import { waffle, ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber } from "ethers";
import { deploy } from "./utils/contracts";

chai.use(solidity);

import {
    OriginationController,
    CallWhitelist,
    MockERC20,
    MockERC721,
    VaultFactory,
    AssetVault,
    PromissoryNote,
    LoanCore,
    FeeController,
    BaseURIDescriptor,
    RepaymentController,
} from "../typechain";
import { approve, mint } from "./utils/erc20";
import { mint as mint721 } from "./utils/erc721";
import { BlockchainTime } from "./utils/time";
import { Borrower, LoanData, LoanTerms, SignatureProperties } from "./utils/types";
import { createLoanTermsSignature } from "./utils/eip712";
import { initializeBundle } from "./utils/loans";

import {
    ORIGINATOR_ROLE,
    REPAYER_ROLE,
    BASE_URI,
    MIN_LOAN_PRINCIPAL,
    EIP712_VERSION
} from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    originationController: OriginationController;
    repaymentController: RepaymentController;
    feeController: FeeController;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    vaultFactory: VaultFactory;
    vault: AssetVault;
    lenderPromissoryNote: PromissoryNote;
    borrowerPromissoryNote: PromissoryNote;
    loanCore: LoanCore;
    lender: Signer;
    borrower: Signer;
    newLender: Signer;
    signers: Signer[];
    blockchainTime: BlockchainTime;
}

/**
 * Creates a vault instance using the vault factory
 */
const createVault = async (factory: VaultFactory, user: Signer): Promise<AssetVault> => {
    const tx = await factory.connect(user).initializeBundle(user.address);
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

const fixture = async (): Promise<TestContext> => {
    const blockchainTime = new BlockchainTime();

    const signers: Signer[] = await ethers.getSigners();
    const [deployer] = signers;

    const feeController = <FeeController>await deploy("FeeController", signers[0], []);
    const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI])

    const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", deployer, ["Arcade.xyz BorrowerNote", "aBN", descriptor.address]);
    const lenderNote = <PromissoryNote>await deploy("PromissoryNote", deployer, ["Arcade.xyz LenderNote", "aLN", descriptor.address]);

    const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [borrowerNote.address, lenderNote.address]);

    // Grant correct permissions for promissory note
    for (const note of [borrowerNote, lenderNote]) {
        await note.connect(deployer).initialize(loanCore.address);
    }

    const whitelist = <CallWhitelist>await deploy("CallWhitelist", deployer, []);
    const vaultTemplate = <AssetVault>await deploy("AssetVault", deployer, []);
    const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address])

    const vault = await createVault(vaultFactory, signers[0]);

    const mockERC20 = <MockERC20>await deploy("MockERC20", deployer, ["Mock ERC20", "MOCK"]);
    const mockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);

    const repaymentController = <RepaymentController>await deploy("RepaymentController", deployer, [loanCore.address, feeController.address]);
    await repaymentController.deployed();
    const updateRepaymentControllerPermissions = await loanCore.grantRole(
        REPAYER_ROLE,
        repaymentController.address,
    );
    await updateRepaymentControllerPermissions.wait();

    const originationController = <OriginationController>await deploy(
        "OriginationController", signers[0], [loanCore.address, feeController.address]
    )
    await originationController.deployed();

    // admin whitelists MockERC20 on OriginationController
    const whitelistCurrency = await originationController.setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    await whitelistCurrency.wait();
    // verify the currency is whitelisted
    const isWhitelisted = await originationController.isAllowedCurrency(mockERC20.address);
    expect(isWhitelisted).to.be.true;

    // admin whitelists MockERC721 and vaultFactory on OriginationController
    await originationController.setAllowedCollateralAddresses(
        [mockERC721.address, vaultFactory.address],
        [true, true]
    );

    // verify the collateral is whitelisted
    const isCollateralWhitelisted = await originationController.isAllowedCollateral(mockERC721.address);
    expect(isCollateralWhitelisted).to.be.true;
    const isVaultFactoryWhitelisted = await originationController.isAllowedCollateral(vaultFactory.address);
    expect(isVaultFactoryWhitelisted).to.be.true;

    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    return {
        originationController,
        repaymentController,
        feeController,
        mockERC20,
        mockERC721,
        vaultFactory,
        vault,
        lenderPromissoryNote: lenderNote,
        borrowerPromissoryNote: borrowerNote,
        loanCore,
        lender: deployer,
        borrower: signers[1],
        newLender: signers[2],
        signers: signers.slice(2),
        blockchainTime,
    };
};

const createLoanTerms = (
    payableCurrency: string,
    collateralAddress: string,
    {
        durationSecs = BigNumber.from(360000),
        principal = ethers.utils.parseEther("100"),
        interestRate = BigNumber.from(1000),
        collateralId = "1",
        deadline = 1754884800,
        affiliateCode = ethers.constants.HashZero
    }: Partial<LoanTerms> = {},
): LoanTerms => {
    return {
        durationSecs,
        principal,
        interestRate,
        collateralId,
        collateralAddress,
        payableCurrency,
        deadline,
        affiliateCode
    };
};

const defaultSigProperties: SignatureProperties = {
    nonce: 1,
    maxUses: 1,
};

describe("Refinancing", () => {
    let ctx: TestContext;
    let borrowerStruct: Borrower;

    beforeEach(async () => {
        ctx = await loadFixture(fixture);
        const { borrower } = ctx;

        borrowerStruct = {
            borrower: borrower.address,
            callbackData: "0x"
        };
    });

    describe("refinance active loan", () => {
        it("Refinance loan with nothing owed to borrower, same due date", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms, same due date, better interest and principal
            const loanData: LoanData = await loanCore.getLoan(1);
            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: loanTerms.principal.sub(loanTerms.principal.div(BigNumber.from(100))),
                interestRate: BigNumber.from(500),
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            let newLenderOwes: BigNumber;
            if (refiLoanTerms.principal.gt(loanData.balance)) {
                newLenderOwes = refiLoanTerms.principal.add(interestDue);
            } else {
                newLenderOwes = loanData.balance.sub(refiLoanTerms.principal).add(interestDue).add(refiLoanTerms.principal);
            }

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);

            // refinance loan
            expect(await loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.emit(loanCore, "LoanRefinanced");

            const oldLenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);

            // accounting checks
            expect(oldLenderBalanceAfter).to.equal(oldLenderBalanceBefore.add(loanTerms.principal.add(interestDue)));
            expect(newLenderBalanceAfter).to.equal(newLenderBalanceBefore.sub(newLenderOwes));
            expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore);

            // loan state checks
            const loanData1After: LoanData = await loanCore.getLoan(1);
            expect(loanData1After.state).to.equal(2); // repaid
            expect(loanData1After.balance).to.equal(0);
            expect(loanData1After.interestAmountPaid).to.equal(interestDue);

            const loanDataAfter: LoanData = await loanCore.getLoan(2);
            expect(loanDataAfter.state).to.equal(1); // active
            expect(loanDataAfter.balance).to.equal(refiLoanTerms.principal);
            expect(loanDataAfter.interestAmountPaid).to.equal(0);
        });

        it("Refinance loan, new principal larger than old principal, borrower receives, same due date", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms: 10 more than owed
            const loanData: LoanData = await loanCore.getLoan(1);
            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: ethers.utils.parseEther("110"),
                interestRate: BigNumber.from(500),
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            let newLenderOwes: BigNumber;
            if (refiLoanTerms.principal.gt(loanData.balance)) {
                newLenderOwes = refiLoanTerms.principal.add(interestDue);
            } else {
                newLenderOwes = loanData.balance.sub(refiLoanTerms.principal).add(interestDue).add(refiLoanTerms.principal);
            }

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);

            // refinance loan
            expect(await loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.emit(loanCore, "LoanRefinanced");

            const oldLenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);

            // accounting checks: borrower receives 10 - interest due on old loan
            expect(oldLenderBalanceAfter).to.equal(oldLenderBalanceBefore.add(loanTerms.principal.add(interestDue)));
            expect(newLenderBalanceAfter).to.equal(newLenderBalanceBefore.sub(newLenderOwes));
            expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore.add(ethers.utils.parseEther("10")));

            // loan state checks
            const loanData1After: LoanData = await loanCore.getLoan(1);
            expect(loanData1After.state).to.equal(2); // repaid
            expect(loanData1After.balance).to.equal(0);
            expect(loanData1After.interestAmountPaid).to.equal(interestDue);

            const loanDataAfter: LoanData = await loanCore.getLoan(2);
            expect(loanDataAfter.state).to.equal(1); // active
            expect(loanDataAfter.balance).to.equal(refiLoanTerms.principal);
            expect(loanDataAfter.interestAmountPaid).to.equal(0);
        });

        it("Refinance loan, new principal less than old principal, new lender owes difference, same due date", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms: 10 more than owed
            const loanData: LoanData = await loanCore.getLoan(1);
            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: ethers.utils.parseEther("90"),
                interestRate: BigNumber.from(500),
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            let newLenderOwes: BigNumber;
            if (refiLoanTerms.principal.gt(loanData.balance)) {
                newLenderOwes = refiLoanTerms.principal.add(interestDue);
            } else {
                newLenderOwes = loanData.balance.sub(refiLoanTerms.principal).add(interestDue).add(refiLoanTerms.principal);
            }

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);

            // refinance loan
            expect(await loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.emit(loanCore, "LoanRefinanced");

            const oldLenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);

            // accounting checks: borrower receives 10 - interest due on old loan
            expect(oldLenderBalanceAfter).to.equal(oldLenderBalanceBefore.add(loanTerms.principal.add(interestDue)));
            expect(newLenderBalanceAfter).to.equal(newLenderBalanceBefore.sub(newLenderOwes));
            expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore);

            // loan state checks
            const loanData1After: LoanData = await loanCore.getLoan(1);
            expect(loanData1After.state).to.equal(2); // repaid
            expect(loanData1After.balance).to.equal(0);
            expect(loanData1After.interestAmountPaid).to.equal(interestDue);

            const loanDataAfter: LoanData = await loanCore.getLoan(2);
            expect(loanDataAfter.state).to.equal(1); // active
            expect(loanDataAfter.balance).to.equal(refiLoanTerms.principal);
            expect(loanDataAfter.interestAmountPaid).to.equal(0);
        });
    });

    describe("refinance constraints", () => {
        it("Cannot refinance a closed loan", async () => {
            const { repaymentController, originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // borrower repays
            await mint(mockERC20, borrower, ethers.utils.parseEther("110"));
            await approve(mockERC20, borrower, loanCore.address, ethers.utils.parseEther("110"));
            await repaymentController.connect(borrower).repay(1, ethers.utils.parseEther("110"));

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(500)
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("LC_InvalidState");
        });

        it("Cannot refinance before 2 days have past on old loan", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 47 hours
            await blockchainTime.increaseTime(60 * 60 * 47);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(500)
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("OCR_TooEarly");
        });

        it("Invalid new interest rate, too low", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);

            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));

            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(0),
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("OCR_InterestRate");
        });

        it("Invalid new interest rate, too high", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);

            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));

            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(100000001),
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("OCR_InterestRate");
        });

        it("due date is the same, new principal is not less than 1% of old principal, ", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms, same due date, better interest and principal
            const loanData: LoanData = await loanCore.getLoan(1);
            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: loanTerms.principal.sub(loanTerms.principal.div(BigNumber.from(101))),
                interestRate: BigNumber.from(500),
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            let newLenderOwes: BigNumber;
            if (refiLoanTerms.principal.gt(loanData.balance)) {
                newLenderOwes = refiLoanTerms.principal.add(interestDue);
            } else {
                newLenderOwes = loanData.balance.sub(refiLoanTerms.principal).add(interestDue).add(refiLoanTerms.principal);
            }

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("OCR_PrincipalDifferenceOne");

        });

        it("due date is extended, new principal is not less than 10% of remaining duration, ", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms, same due date, better interest and principal
            const loanData: LoanData = await loanCore.getLoan(1);

            const remainingDuration = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs).sub(await blockchainTime.secondsFromNow(3));
            const remainingDurationTenPercent = remainingDuration.div(BigNumber.from(10));
            const minimumTenPercentRemPrincipal = loanTerms.principal.mul(remainingDurationTenPercent).div(loanData.terms.durationSecs);

            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const longerDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3)).add(3600);

            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: loanTerms.principal.sub(minimumTenPercentRemPrincipal).add(1),
                interestRate: BigNumber.from(500),
                durationSecs: longerDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            let newLenderOwes: BigNumber;
            if (refiLoanTerms.principal.gt(loanData.balance)) {
                newLenderOwes = refiLoanTerms.principal.add(interestDue);
            } else {
                newLenderOwes = loanData.balance.sub(refiLoanTerms.principal).add(interestDue).add(refiLoanTerms.principal);
            }

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("OCR_PrincipalDifferenceTen");

        });

        it("New APR must be minimum 5% less then old APR", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);

            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));

            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(951), // 950 minimum allowable
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("OCR_AprTooHigh");
        });

        it("New loan duration must be equal to, or longer than previous", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);


            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));

            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(500),
                durationSecs: sameDueDate.sub(1) // 1 second less than original
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("OCR_LoanDuration");
        });

        it("If larger new loan principal, daily interest must be reduced, rejected", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);

            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));

            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: ethers.utils.parseEther("200"),
                interestRate: BigNumber.from(500),
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("OCR_DailyInterestRate");
        });

        it("If larger new loan principal, daily interest must be reduced, accepted", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);

            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));

            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: ethers.utils.parseEther("105"),
                interestRate: BigNumber.from(950),
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.emit(loanCore, "LoanRefinanced");
        });

        it("Collateral cannot be changed in during refinancing", async () => {
            const { originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);
            const refiLoanTerms1 = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: BigNumber.from(1234),
                interestRate: BigNumber.from(500)
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms1.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms1))
                .to.be.revertedWith("OCR_CollateralMismatch");

            const refiLoanTerms2 = createLoanTerms(mockERC20.address, ethers.constants.AddressZero, {
                collateralId: bundleId,
                interestRate: BigNumber.from(500)
            });

            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms2))
                .to.be.revertedWith("OCR_CollateralMismatch");
        });

        it("Payable currency cannot be changed in during refinancing", async () => {
            const { repaymentController, originationController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);
            await approve(mockERC20, lender, originationController.address, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // start initial loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);
            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);
            const refiLoanTerms = createLoanTerms(ethers.constants.AddressZero, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(500)
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = await originationController.getProratedInterestAmount(
                loanData.balance,
                loanData.terms.interestRate,
                loanData.terms.durationSecs,
                loanData.startDate,
                loanData.lastAccrualTimestamp,
                await blockchainTime.secondsFromNow(3),
            );

            const newLenderOwes = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(loanCore.connect(newLender).refinance(1, refiLoanTerms))
                .to.be.revertedWith("OCR_CurrencyMismatch");
        });
    });
});
