import chai, { expect } from "chai";
import { waffle, ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber } from "ethers";
import { deploy } from "./utils/contracts";

chai.use(solidity);

import {
    CallWhitelist,
    MockERC20,
    VaultFactory,
    AssetVault,
    PromissoryNote,
    LoanCore,
    ArcadeItemsVerifier,
    FeeController,
    BaseURIDescriptor,
    OriginationHelpers,
    MockERC20WithDecimals,
    RepaymentController,
    OriginationControllerInterestRateSwap,
} from "../typechain";
import { mint, ZERO_ADDRESS } from "./utils/erc20";
import { LoanTerms, SignatureProperties, SwapData } from "./utils/types";
import { createLoanTermsSignature } from "./utils/eip712";

import {
    ORIGINATOR_ROLE,
    BASE_URI,
    REPAYER_ROLE,
    EIP712_VERSION
} from "./utils/constants";
import { BlockchainTime } from "./utils/time";

type Signer = SignerWithAddress;

interface TestContext {
    originationHelpers: OriginationHelpers;
    originationControllerIRS: OriginationControllerInterestRateSwap;
    repaymentController: RepaymentController;
    feeController: FeeController;
    USDC: MockERC20WithDecimals;
    sUSDe: MockERC20;
    vaultFactory: VaultFactory;
    lenderPromissoryNote: PromissoryNote;
    borrowerPromissoryNote: PromissoryNote;
    loanCore: LoanCore;
    user: Signer;
    other: Signer;
    signers: Signer[];
    blockchainTime: BlockchainTime;
}

const fixture = async (): Promise<TestContext> => {
    const blockchainTime = new BlockchainTime();

    const signers: Signer[] = await ethers.getSigners();
    const [deployer] = signers;

    const feeController = <FeeController>await deploy("FeeController", signers[0], []);
    const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI])

    const borrowerNote = <PromissoryNote>await deploy("PromissoryNote", deployer, ["Arcade.xyz BorrowerNote", "aBN", descriptor.address]);
    const lenderNote = <PromissoryNote>await deploy("PromissoryNote", deployer, ["Arcade.xyz LenderNote", "aLN", descriptor.address]);

    const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [borrowerNote.address, lenderNote.address]);

    // grant correct permissions for promissory note
    for (const note of [borrowerNote, lenderNote]) {
        await note.connect(deployer).initialize(loanCore.address);
    }

    const whitelist = <CallWhitelist>await deploy("CallWhitelist", deployer, []);
    const vaultTemplate = <AssetVault>await deploy("AssetVault", deployer, []);
    const vaultFactory = <VaultFactory>await deploy("VaultFactory", signers[0], [vaultTemplate.address, whitelist.address, feeController.address, descriptor.address])

    const USDC = <MockERC20WithDecimals>await deploy("MockERC20WithDecimals", deployer, ["USDC", "USDC", 6]);
    const sUSDe = <MockERC20>await deploy("MockERC20", deployer, ["sUSDe", "sUSDe"]);

    const originationHelpers = <OriginationHelpers> await  deploy("OriginationHelpers", deployer, []);

    const originationLibrary = await deploy("OriginationLibrary", deployer, []);
    const OriginationControllerIRSFactory = await ethers.getContractFactory("OriginationControllerInterestRateSwap",
        {
            signer: signers[0],
            libraries: {
                OriginationLibrary: originationLibrary.address,
            },
        },
    );
    const originationControllerIRS = <OriginationControllerInterestRateSwap>(
        await OriginationControllerIRSFactory.deploy(originationHelpers.address, loanCore.address, feeController.address, vaultFactory.address)
    );
    await originationControllerIRS.deployed();

    // admin whitelists MockERC20s in OriginationHelpers
    const whitelistCurrency = await originationHelpers.setAllowedPayableCurrencies([USDC.address], [{ isAllowed: true, minPrincipal: 1000000 }]);
    await whitelistCurrency.wait();
    const whitelistCurrency2 = await originationHelpers.setAllowedPayableCurrencies([sUSDe.address], [{ isAllowed: true, minPrincipal: ethers.utils.parseEther("1") }]);
    await whitelistCurrency2.wait();
    // verify the currencies are whitelisted
    const isWhitelisted = await originationHelpers.isAllowedCurrency(USDC.address);
    expect(isWhitelisted).to.be.true;
    const isWhitelisted2 = await originationHelpers.isAllowedCurrency(sUSDe.address);
    expect(isWhitelisted2).to.be.true;

    // admin whitelists pair for interest rate swaps
    await originationControllerIRS.setPair(USDC.address, sUSDe.address, 1e12, true);
    // verify the pair is whitelisted
    const key = ethers.utils.solidityKeccak256(["address", "address", "uint256"], [USDC.address, sUSDe.address, 1e12]);
    const isPairWhitelisted = await originationControllerIRS.currencyPairs(key);
    expect(isPairWhitelisted).to.be.true;

    // admin whitelists MockERC721 and vaultFactory in OriginationHelpers
    await originationHelpers.setAllowedCollateralAddresses([vaultFactory.address], [true]);

    // verify the collateral is whitelisted
    const isVaultFactoryWhitelisted = await originationHelpers.isAllowedCollateral(vaultFactory.address);
    expect(isVaultFactoryWhitelisted).to.be.true;

    const repaymentController = <RepaymentController>await deploy("RepaymentController", deployer, [loanCore.address, feeController.address]);

    await repaymentController.deployed();
    const updateRepaymentControllerPermissions = await loanCore.grantRole(REPAYER_ROLE, repaymentController.address);
    await updateRepaymentControllerPermissions.wait();

    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationControllerIRS.address,
    );
    await updateOriginationControllerPermissions.wait();

    return {
        originationHelpers,
        originationControllerIRS,
        repaymentController,
        feeController,
        USDC,
        sUSDe,
        vaultFactory,
        lenderPromissoryNote: lenderNote,
        borrowerPromissoryNote: borrowerNote,
        loanCore,
        user: deployer,
        other: signers[1],
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
        interestRate = BigNumber.from(1),
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

describe("OriginationControllerInterestRateSwap", () => {
    describe("Interest rate swap origination", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { lenderPromissoryNote, borrowerPromissoryNote } = ctx;

            expect(await lenderPromissoryNote.totalSupply()).to.eq(0);
            expect(await borrowerPromissoryNote.totalSupply()).to.eq(0);
        });

        it("lender with 1,000,000 variable rate sUSDe locking in fixed rate of 15%", async () => {
            const { vaultFactory, originationControllerIRS, loanCore, USDC, sUSDe, user: lender, other: borrower } = ctx;

            // Lender has 1,000,000 sUSDe they want to lock in a fixed rate of 15% APR on
            const susdeLenderSwapAmount = ethers.utils.parseEther("1000000");
            await mint(sUSDe, lender, susdeLenderSwapAmount);

            // Signature and loan terms
            const loanTerms = createLoanTerms(
                USDC.address, vaultFactory.address, {
                    collateralId: BigNumber.from(0), // completed by the origination controller
                    principal: BigNumber.from(1000000000000), // 1,000,000 USDC
                    interestRate: BigNumber.from(1500), // 15% interest amount makes the repayment amount 1,150,000 USDC after 1 year
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            const sig = await createLoanTermsSignature(
                originationControllerIRS.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // lender approves sUSDe to swap
            await sUSDe.connect(lender).approve(originationControllerIRS.address, susdeLenderSwapAmount);

            // borrower approves sUSDe to swap
            const susdeBorrowerSwapAmount = ethers.utils.parseEther("150000");
            await mint(sUSDe, borrower, susdeBorrowerSwapAmount);
            await sUSDe.connect(borrower).approve(originationControllerIRS.address, susdeBorrowerSwapAmount);

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(susdeBorrowerSwapAmount);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(susdeLenderSwapAmount);

            // Borrower initiates interest rate swap
            const swapData: SwapData = {
                vaultedCurrency: sUSDe.address,
                payableToVaultedCurrencyRatio: ethers.utils.parseEther("1").div(BigNumber.from(1000000)),
            }

            // initialize swap
            await originationControllerIRS
                .connect(borrower)
                .initializeSwap(
                    loanTerms,
                    swapData,
                    borrower.address,
                    lender.address,
                    sig,
                    defaultSigProperties,
                );

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(0);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(0);

            // check loan core is the owner of the vault
            const bundleId = await vaultFactory.instanceAtIndex(0);
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);
        })

        it("lender with 1,000,000 variable rate sUSDe locking in fixed rate of 15%, borrower repays", async () => {
            const { vaultFactory, originationControllerIRS, loanCore, USDC, sUSDe, user: lender, other: borrower, repaymentController, blockchainTime } = ctx;

            // Lender has 1,000,000 sUSDe they want to lock in a fixed rate of 15% APR on
            const susdeLenderSwapAmount = ethers.utils.parseEther("1000000");
            await mint(sUSDe, lender, susdeLenderSwapAmount);

            // Signature and loan terms
            const loanTerms = createLoanTerms(
                USDC.address, vaultFactory.address, {
                    collateralId: BigNumber.from(0), // completed by the origination controller
                    principal: BigNumber.from(1000000000000), // 1,000,000 USDC
                    interestRate: BigNumber.from(1500), // 15% interest amount makes the repayment amount 1,150,000 USDC after 1 year
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            const sig = await createLoanTermsSignature(
                originationControllerIRS.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // lender approves sUSDe to swap
            await sUSDe.connect(lender).approve(originationControllerIRS.address, susdeLenderSwapAmount);

            // borrower approves sUSDe to swap
            const susdeBorrowerSwapAmount = ethers.utils.parseEther("150000");
            await mint(sUSDe, borrower, susdeBorrowerSwapAmount);
            await sUSDe.connect(borrower).approve(originationControllerIRS.address, susdeBorrowerSwapAmount);

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(susdeBorrowerSwapAmount);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(susdeLenderSwapAmount);

            // Borrower initiates interest rate swap
            const swapData: SwapData = {
                vaultedCurrency: sUSDe.address,
                payableToVaultedCurrencyRatio: ethers.utils.parseEther("1").div(BigNumber.from(1000000)),
            }

            // initialize swap
            await originationControllerIRS
                .connect(borrower)
                .initializeSwap(
                    loanTerms,
                    swapData,
                    borrower.address,
                    lender.address,
                    sig,
                    defaultSigProperties,
                );

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(0);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(0);

            // check loan core is the owner of the vault
            const bundleId = await vaultFactory.instanceAtIndex(0);
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            // check USDC balance of borrower and lender
            expect(await USDC.balanceOf(borrower.address)).to.equal(0);
            expect(await USDC.balanceOf(lender.address)).to.equal(0);

            // check loan core is the owner of the vault
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            // fast forward to the end of the loan
            await blockchainTime.increaseTime(BigNumber.from(loanTerms.durationSecs).toNumber());

            // mint borrower repay amount
            const borrowerRepayAmount = ethers.utils.parseUnits("1150000", 6);
            await mint(USDC, borrower, borrowerRepayAmount);
            await USDC.connect(borrower).approve(loanCore.address, borrowerRepayAmount);

            // check USDC balance of borrower and lender
            expect(await USDC.balanceOf(borrower.address)).to.equal(borrowerRepayAmount);
            expect(await USDC.balanceOf(lender.address)).to.equal(0);

            // borrower calls repayFull
            expect(await repaymentController.connect(borrower).repayFull(1))
                .to.emit(loanCore, "LoanRepaid").withArgs(1);

            // check USDC balance of borrower and lender
            expect(await USDC.balanceOf(borrower.address)).to.equal(0);
            expect(await USDC.balanceOf(lender.address)).to.equal(borrowerRepayAmount);

            // check owner of the vault is the borrower
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);
        })

        it("lender with 1,000,000 variable rate sUSDe locking in fixed rate of 15%, borrower defaults", async () => {
            const { vaultFactory, originationControllerIRS, loanCore, USDC, sUSDe, user: lender, other: borrower, repaymentController, blockchainTime } = ctx;

            // Lender has 1,000,000 sUSDe they want to lock in a fixed rate of 15% APR on
            const susdeLenderSwapAmount = ethers.utils.parseEther("1000000");
            await mint(sUSDe, lender, susdeLenderSwapAmount);

            // Signature and loan terms
            const loanTerms = createLoanTerms(
                USDC.address, vaultFactory.address, {
                    collateralId: BigNumber.from(0), // completed by the origination controller
                    principal: BigNumber.from(1000000000000), // 1,000,000 USDC
                    interestRate: BigNumber.from(1500), // 15% interest amount makes the repayment amount 1,150,000 USDC after 1 year
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            const sig = await createLoanTermsSignature(
                originationControllerIRS.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // lender approves sUSDe to swap
            await sUSDe.connect(lender).approve(originationControllerIRS.address, susdeLenderSwapAmount);

            // borrower approves sUSDe to swap
            const susdeBorrowerSwapAmount = ethers.utils.parseEther("150000");
            await mint(sUSDe, borrower, susdeBorrowerSwapAmount);
            await sUSDe.connect(borrower).approve(originationControllerIRS.address, susdeBorrowerSwapAmount);

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(susdeBorrowerSwapAmount);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(susdeLenderSwapAmount);

            // Borrower initiates interest rate swap
            const swapData: SwapData = {
                vaultedCurrency: sUSDe.address,
                payableToVaultedCurrencyRatio: ethers.utils.parseEther("1").div(BigNumber.from(1000000)),
            }

            // initialize swap
            await originationControllerIRS
                .connect(borrower)
                .initializeSwap(
                    loanTerms,
                    swapData,
                    borrower.address,
                    lender.address,
                    sig,
                    defaultSigProperties,
                );

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(0);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(0);

            // check loan core is the owner of the vault
            const bundleId = await vaultFactory.instanceAtIndex(0);
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            // fast forward to the end of the loan
            await blockchainTime.increaseTime(BigNumber.from(loanTerms.durationSecs).add(60 * 10).toNumber());

            // borrower defaults
            expect(await repaymentController.connect(lender).claim(1))
                .to.emit(loanCore, "LoanClaimed").withArgs(1);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(lender.address);
        })

        it("lender originates swap", async () => {
            const { vaultFactory, originationControllerIRS, loanCore, USDC, sUSDe, user: lender, other: borrower } = ctx;

            // Lender has 1,000,000 sUSDe they want to lock in a fixed rate of 15% APR on
            const susdeLenderSwapAmount = ethers.utils.parseEther("1000000");
            await mint(sUSDe, lender, susdeLenderSwapAmount);

            // Signature and loan terms
            const loanTerms = createLoanTerms(
                USDC.address, vaultFactory.address, {
                    collateralId: BigNumber.from(0), // completed by the origination controller
                    principal: BigNumber.from(1000000000000), // 1,000,000 USDC
                    interestRate: BigNumber.from(1500), // 15% interest amount makes the repayment amount 1,150,000 USDC after 1 year
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            const sig = await createLoanTermsSignature(
                originationControllerIRS.address,
                "OriginationController",
                loanTerms,
                borrower,
                EIP712_VERSION,
                defaultSigProperties,
                "b",
            );

            // lender approves sUSDe to swap
            await sUSDe.connect(lender).approve(originationControllerIRS.address, susdeLenderSwapAmount);

            // borrower approves sUSDe to swap
            const susdeBorrowerSwapAmount = ethers.utils.parseEther("150000");
            await mint(sUSDe, borrower, susdeBorrowerSwapAmount);
            await sUSDe.connect(borrower).approve(originationControllerIRS.address, susdeBorrowerSwapAmount);

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(susdeBorrowerSwapAmount);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(susdeLenderSwapAmount);

            // Borrower initiates interest rate swap
            const swapData: SwapData = {
                vaultedCurrency: sUSDe.address,
                payableToVaultedCurrencyRatio: ethers.utils.parseEther("1").div(BigNumber.from(1000000)),
            }

            // initialize swap
            await originationControllerIRS
                .connect(lender)
                .initializeSwap(
                    loanTerms,
                    swapData,
                    borrower.address,
                    lender.address,
                    sig,
                    defaultSigProperties,
                );

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(0);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(0);

            // check loan core is the owner of the vault
            const bundleId = await vaultFactory.instanceAtIndex(0);
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);
        })
    });

    describe("Interest rate swap constraints", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { lenderPromissoryNote, borrowerPromissoryNote } = ctx;

            expect(await lenderPromissoryNote.totalSupply()).to.eq(0);
            expect(await borrowerPromissoryNote.totalSupply()).to.eq(0);
        });

        it("invalid constructor arguments", async () => {
            const { originationHelpers, loanCore, feeController, vaultFactory, user } = await loadFixture(fixture);

            const originationLibrary = await deploy("OriginationLibrary", user, []);
            const OriginationControllerIRSFactory = await ethers.getContractFactory("OriginationControllerInterestRateSwap",
                {
                    libraries: {
                        OriginationLibrary: originationLibrary.address,
                    },
                },
            );

            await expect(OriginationControllerIRSFactory.deploy(originationHelpers.address, loanCore.address, ZERO_ADDRESS, vaultFactory.address)).to.be.revertedWith(
                `OCIRS_ZeroAddress("feeController")`
            );

            await expect(OriginationControllerIRSFactory.deploy(originationHelpers.address, loanCore.address, feeController.address, ZERO_ADDRESS)).to.be.revertedWith(
                `OCIRS_ZeroAddress("vaultFactory")`
            );
        })

        it("currency pair is not whitelisted", async () => {
            const { vaultFactory, originationControllerIRS, USDC, sUSDe, user: lender, other: borrower } = ctx;

            // Lender has 1,000,000 sUSDe they want to lock in a fixed rate of 15% APR on
            const susdeLenderSwapAmount = ethers.utils.parseEther("1000000");
            await mint(sUSDe, lender, susdeLenderSwapAmount);

            // Signature and loan terms
            const loanTerms = createLoanTerms(
                USDC.address, vaultFactory.address, {
                    collateralId: BigNumber.from(0), // completed by the origination controller
                    principal: BigNumber.from(1000000000000), // 1,000,000 USDC
                    interestRate: BigNumber.from(1500), // 15% interest amount makes the repayment amount 1,150,000 USDC after 1 year
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            const sig = await createLoanTermsSignature(
                originationControllerIRS.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // lender approves sUSDe to swap
            await sUSDe.connect(lender).approve(originationControllerIRS.address, susdeLenderSwapAmount);

            // borrower approves sUSDe to swap
            const susdeBorrowerSwapAmount = ethers.utils.parseEther("150000");
            await mint(sUSDe, borrower, susdeBorrowerSwapAmount);
            await sUSDe.connect(borrower).approve(originationControllerIRS.address, susdeBorrowerSwapAmount);

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(susdeBorrowerSwapAmount);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(susdeLenderSwapAmount);

            // Borrower initiates interest rate swap
            const swapData: SwapData = {
                vaultedCurrency: ethers.constants.AddressZero,
                payableToVaultedCurrencyRatio: ethers.utils.parseEther("1").div(BigNumber.from(1000000)),
            }

            await expect(
                originationControllerIRS
                    .connect(borrower)
                    .initializeSwap(
                        loanTerms,
                        swapData,
                        borrower.address,
                        lender.address,
                        sig,
                        defaultSigProperties,
                    ),
            )
                .to.be.revertedWith("OCIRS_InvalidPair");
        })
    });
});
