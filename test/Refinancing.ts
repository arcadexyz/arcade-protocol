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
    OriginationConfiguration,
    RefinanceController,
    OriginationLibrary,
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
    EIP712_VERSION,
    AFFILIATE_MANAGER_ROLE,
    FEE_CLAIMER_ROLE,
    SIG_DEADLINE
} from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    originationConfiguration: OriginationConfiguration;
    originationLibrary: OriginationLibrary;
    originationController: OriginationController;
    refinanceController: RefinanceController;
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

    const originationConfiguration = <OriginationConfiguration> await deploy("OriginationConfiguration", deployer, []);

    const originationLibrary = <OriginationLibrary> await deploy("OriginationLibrary", deployer, []);
    const OriginationControllerFactory = await ethers.getContractFactory("OriginationController",
        {
            signer: signers[0],
            libraries: {
                OriginationLibrary: originationLibrary.address,
            },
        },
    );
    const originationController = <OriginationController>(
        await OriginationControllerFactory.deploy(originationConfiguration.address, loanCore.address, feeController.address)
    );
    await originationController.deployed();

    const refinanceController = <RefinanceController>await deploy("RefinanceController", deployer, [originationConfiguration.address, loanCore.address]);

    // admin whitelists MockERC20 on OriginationController
    const whitelistCurrency = await originationConfiguration.setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    await whitelistCurrency.wait();
    // verify the currency is whitelisted
    const isWhitelisted = await originationConfiguration.isAllowedCurrency(mockERC20.address);
    expect(isWhitelisted).to.be.true;

    // admin whitelists MockERC721 and vaultFactory on OriginationController
    await originationConfiguration.setAllowedCollateralAddresses(
        [mockERC721.address, vaultFactory.address],
        [true, true]
    );

    // verify the collateral is whitelisted
    const isCollateralWhitelisted = await originationConfiguration.isAllowedCollateral(mockERC721.address);
    expect(isCollateralWhitelisted).to.be.true;
    const isVaultFactoryWhitelisted = await originationConfiguration.isAllowedCollateral(vaultFactory.address);
    expect(isVaultFactoryWhitelisted).to.be.true;

    // add both OriginationController and refinanceController as originators in LoanCore
    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    const updateRefinanceControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        refinanceController.address,
    );
    await updateRefinanceControllerPermissions.wait();

    // set fee roles
    await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, signers[3].address);
    await loanCore.grantRole(FEE_CLAIMER_ROLE, signers[3].address);

    return {
        originationConfiguration,
        originationLibrary,
        originationController,
        refinanceController,
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
        signers: signers.slice(3),
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
        deadline = SIG_DEADLINE,
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

    describe("constructor", () => {
        it("cannot pass in zero address for shared storage", async () => {
            const { loanCore } = ctx;

            await expect(
               deploy("RefinanceController", ctx.signers[0], [ethers.constants.AddressZero, loanCore.address])
            ).to.be.revertedWith("REFI_ZeroAddress");
        });

        it("cannot pass in zero address for loan core", async () => {
            const { originationConfiguration } = ctx;

            await expect(
                deploy("RefinanceController", ctx.signers[0], [originationConfiguration.address, ethers.constants.AddressZero])
            ).to.be.revertedWith("REFI_ZeroAddress");
        });
    });

    describe("refinance active loan", () => {
        it("same principal, same due date", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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
                principal: loanTerms.principal, // same principal
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

            const newLenderOwes: BigNumber = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, refinanceController.address, newLenderOwes);

            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);

            // refinance loan
            expect(await refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.emit(loanCore, "LoanRolledOver");

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

        it("less principal, same due date", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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

            const newLenderOwes: BigNumber = loanData.balance.sub(refiLoanTerms.principal).add(interestDue).add(refiLoanTerms.principal);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, refinanceController.address, newLenderOwes);

            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);

            // refinance loan
            expect(await refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.emit(loanCore, "LoanRolledOver");

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

        it("same principal, same due date, 20% fee on interest", async () => {
            const { feeController, originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_01(), 20_00);

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                durationSecs: BigNumber.from(31536000),
            });
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

            // fast forward to half of the loan for easier fee calculations
            await blockchainTime.increaseTime(31536000 / 2 - 3);

            // refinance loan terms, same due date, better interest and principal
            const loanData: LoanData = await loanCore.getLoan(1);
            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: loanTerms.principal,
                interestRate: BigNumber.from(500),
                durationSecs: sameDueDate
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = ethers.utils.parseEther("5");
            const interestFee = ethers.utils.parseEther("1");

            const newLenderOwes: BigNumber = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, refinanceController.address, newLenderOwes);

            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            // refinance loan
            expect(await refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.emit(loanCore, "LoanRolledOver");

            const oldLenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // accounting checks
            expect(oldLenderBalanceAfter).to.equal(oldLenderBalanceBefore.add(loanTerms.principal.add(interestDue).sub(interestFee)));
            expect(newLenderBalanceAfter).to.equal(newLenderBalanceBefore.sub(newLenderOwes));
            expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore);
            expect(loanCoreBalanceAfter).to.equal(loanCoreBalanceBefore.add(interestFee));


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

        it("same principal, same due date, 20% fee on interest, and a 20% affiliate split", async () => {
            const { feeController, originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, signers } = ctx;

            // affiliate code
            const affiliateCode = ethers.utils.id("FOO");

            // Assess fee on lender
            await feeController.setLendingFee(await feeController.FL_01(), 20_00);

            // Add a 20% affiliate split
            await loanCore.connect(signers[0]).setAffiliateSplits([affiliateCode], [{ affiliate: borrower.address, splitBps: 20_00 }])

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                durationSecs: BigNumber.from(31536000)
            });
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

            // fast forward to half of the loan for easier fee calculations
            await blockchainTime.increaseTime(31536000 / 2 - 3);

            // refinance loan terms, same due date, better interest and principal
            const loanData: LoanData = await loanCore.getLoan(1);
            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: loanTerms.principal,
                interestRate: BigNumber.from(500),
                durationSecs: sameDueDate,
                affiliateCode: affiliateCode
            });

            // approve old loan interest and new principal to be collected by LoanCore
            const interestDue = ethers.utils.parseEther("5");
            const interestFee = ethers.utils.parseEther("1");

            let newLenderOwes: BigNumber = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, refinanceController.address, newLenderOwes);

            const oldLenderBalanceBefore = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceBefore = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceBefore = await mockERC20.balanceOf(borrower.address);
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            // refinance loan
            expect(await refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.emit(loanCore, "LoanRolledOver");

            const oldLenderBalanceAfter = await mockERC20.balanceOf(lender.address);
            const newLenderBalanceAfter = await mockERC20.balanceOf(newLender.address);
            const borrowerBalanceAfter = await mockERC20.balanceOf(borrower.address);
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);

            // accounting checks
            expect(oldLenderBalanceAfter).to.equal(oldLenderBalanceBefore.add(loanTerms.principal.add(interestDue).sub(interestFee)));
            expect(newLenderBalanceAfter).to.equal(newLenderBalanceBefore.sub(newLenderOwes));
            expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore);
            expect(loanCoreBalanceAfter).to.equal(loanCoreBalanceBefore.add(interestFee));
            expect(await loanCore.feesWithdrawable(mockERC20.address, borrower.address)).to.eq(ethers.utils.parseEther("0.2"));

            // loan state checks
            const loanData1After: LoanData = await loanCore.getLoan(1);
            expect(loanData1After.state).to.equal(2); // repaid
            expect(loanData1After.balance).to.equal(0);
            expect(loanData1After.interestAmountPaid).to.equal(interestDue);

            const loanDataAfter: LoanData = await loanCore.getLoan(2);
            expect(loanDataAfter.state).to.equal(1); // active
            expect(loanDataAfter.balance).to.equal(refiLoanTerms.principal);
            expect(loanDataAfter.interestAmountPaid).to.equal(0);

            // affiliate fee withdrawal
            await expect(loanCore.connect(borrower).withdraw(mockERC20.address, ethers.utils.parseEther("0.2"), borrower.address))
                .to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, borrower.address, borrower.address, ethers.utils.parseEther("0.2"))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, borrower.address, ethers.utils.parseEther("0.2"));

            // protocol fee withdrawal
            await expect(loanCore.connect(signers[0]).withdrawProtocolFees(mockERC20.address, signers[0].address))
                .to.emit(loanCore, "FeesWithdrawn")
                .withArgs(mockERC20.address, signers[0].address, signers[0].address, ethers.utils.parseEther("0.8"))
                .to.emit(mockERC20, "Transfer")
                .withArgs(loanCore.address, signers[0].address, ethers.utils.parseEther("0.8"));
        });
    });

    describe("refinancing constraints", () => {
        it("Cannot be refinanced by existing lender", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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

            await mint(mockERC20, lender, newLenderOwes);
            await approve(mockERC20, lender, loanCore.address, newLenderOwes);

            // refinance loan
            await expect(refinanceController.connect(lender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_SameLender");
        });

        it("Cannot refinance a closed loan", async () => {
            const { repaymentController, originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_InvalidState");
        });

        it("Cannot refinance before 2 days have past on old loan", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_TooEarly");
        });

        it("Invalid new interest rate, too low", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_InterestRate");
        });

        it("New APR must be less than or equal to the minimum interest rate change percentage", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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
                interestRate: BigNumber.from(901), // 950 minimum allowable
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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_InterestRate");
        });

        it("New loan duration must be equal to, or longer than previous", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_LoanDuration");
        });

        it("New loan duration cannot be longer than the MAX_LOAN_DURATION", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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

            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(500),
                durationSecs: BigNumber.from(94608001) // slightly over 3 years
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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_LoanDuration");
        });

        it("New loan duration cannot be shorter than the MIN_LOAN_DURATION", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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

            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(500),
                durationSecs: BigNumber.from(3599) // less than 1 hour
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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_LoanDuration");
        });

        it("Collateral cannot be changed in during refinancing", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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

            // try to refinance loan with different collateral Id
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms1))
                .to.be.revertedWith("REFI_CollateralMismatch");

            const refiLoanTerms2 = createLoanTerms(mockERC20.address, mockERC721.address, {
                collateralId: bundleId,
                interestRate: BigNumber.from(500)
            });

            // try to refinance loan with different collateral address
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms2))
                .to.be.revertedWith("REFI_CollateralMismatch");
        });

        it("Payable currency cannot be changed in during refinancing", async () => {
            const { originationController, originationConfiguration, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime } = ctx;

            // deploy a new ERC20 token
            const otherERC20 = <MockERC20>await deploy("MockERC20", lender, ["Mock ERC20", "MOCK"]);
            await originationConfiguration.connect(lender).setAllowedPayableCurrencies([otherERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);

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
            const refiLoanTerms = createLoanTerms(otherERC20.address, vaultFactory.address, {
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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_CurrencyMismatch");
        });

        it("Principal cannot be increased", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: loanTerms.principal.add(ethers.utils.parseEther("0.01")),
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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_PrincipalIncrease");
        });

        it("Principal cannot be lower than the payable currencies minimum", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: BigNumber.from(999999),
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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("OCC_PrincipalTooLow");
        });

        it("New principal cannot greater than loan's balance", async () => {
            const { originationController, refinanceController, repaymentController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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

            // borrower repay some
            await mint(mockERC20, borrower, ethers.utils.parseEther("0.01"));
            await approve(mockERC20, borrower, loanCore.address, ethers.utils.parseEther("0.01"));
            await repaymentController.connect(borrower).repay(1, ethers.utils.parseEther("0.01"));

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms
            const loanData: LoanData = await loanCore.getLoan(1);
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: loanTerms.principal,
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
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_PrincipalIncrease");
        });

        it("cannot refinance if old interest rate is minimum (0.01%)", async () => {
            const { originationController, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            const tokenId = await mint721(mockERC721, borrower);
            await mockERC721.connect(borrower).transferFrom(borrower.address, bundleAddress, tokenId);

            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId, interestRate: BigNumber.from(1) });
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
                principal: loanTerms.principal, // same principal
                interestRate: BigNumber.from(1),
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

            const newLenderOwes: BigNumber = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, refinanceController.address, newLenderOwes);

            // try to refinance loan
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("REFI_InterestRate");
        });

        it("cannot refinance with invalid collateral", async () => {
            const { originationController, originationConfiguration, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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

            // admin removes collateral
            await originationConfiguration.connect(lender).setAllowedCollateralAddresses([vaultFactory.address], [false]);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms, same due date, better interest and principal
            const loanData: LoanData = await loanCore.getLoan(1);
            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: loanTerms.principal, // same principal
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

            const newLenderOwes: BigNumber = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, refinanceController.address, newLenderOwes);

            // try to refinance loan
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("OCC_InvalidCollateral");
        });

        it("cannot refinance with invalid payable currency", async () => {
            const { originationController, originationConfiguration, refinanceController, loanCore, mockERC20, mockERC721, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

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

            // admin removes payable currency
            await originationConfiguration.connect(lender).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: false, minPrincipal: MIN_LOAN_PRINCIPAL }]);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // refinance loan terms, same due date, better interest and principal
            const loanData: LoanData = await loanCore.getLoan(1);
            const loanEndDate = BigNumber.from(loanData.startDate).add(loanData.terms.durationSecs);
            const sameDueDate = loanEndDate.sub(await blockchainTime.secondsFromNow(3));
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, {
                collateralId: bundleId,
                principal: loanTerms.principal, // same principal
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

            const newLenderOwes: BigNumber = refiLoanTerms.principal.add(interestDue);

            await mint(mockERC20, newLender, newLenderOwes);
            await approve(mockERC20, newLender, refinanceController.address, newLenderOwes);

            // try to refinance loan
            await expect(refinanceController.connect(newLender).refinanceLoan(1, refiLoanTerms))
                .to.be.revertedWith("OCC_InvalidCurrency");
        });
    });
});
