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
    OriginationControllerSTIRFRY
} from "../typechain";
import { approve, mint } from "./utils/erc20";
import { Borrower, ItemsPredicate, LoanData, LoanTerms, SignatureItem, SignatureProperties, StirfryData } from "./utils/types";
import { createLoanTermsSignature, createLoanItemsSignature } from "./utils/eip712";
import { encodeSignatureItems, initializeBundle } from "./utils/loans";

import {
    ORIGINATOR_ROLE,
    BASE_URI,
    REPAYER_ROLE
} from "./utils/constants";
import { BlockchainTime } from "./utils/time";

type Signer = SignerWithAddress;

interface TestContext {
    originationHelpers: OriginationHelpers;
    originationControllerSTIRFRY: OriginationControllerSTIRFRY;
    repaymentController: RepaymentController;
    feeController: FeeController;
    USDC: MockERC20WithDecimals;
    sUSDe: MockERC20;
    vaultFactory: VaultFactory;
    vault: AssetVault;
    lenderPromissoryNote: PromissoryNote;
    borrowerPromissoryNote: PromissoryNote;
    loanCore: LoanCore;
    user: Signer;
    other: Signer;
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

    const USDC = <MockERC20WithDecimals>await deploy("MockERC20WithDecimals", deployer, ["USDC", "USDC", 6]);
    const sUSDe = <MockERC20>await deploy("MockERC20", deployer, ["sUSDe", "sUSDe"]);

    const originationHelpers = <OriginationHelpers> await  deploy("OriginationHelpers", deployer, []);

    const originationLibrary = await deploy("OriginationLibrary", deployer, []);
    const OriginationControllerSTIRFRYFactory = await ethers.getContractFactory("OriginationControllerSTIRFRY",
        {
            signer: signers[0],
            libraries: {
                OriginationLibrary: originationLibrary.address,
            },
        },
    );
    const originationControllerSTIRFRY = <OriginationControllerSTIRFRY>(
        await OriginationControllerSTIRFRYFactory.deploy(originationHelpers.address, loanCore.address, feeController.address, vaultFactory.address)
    );
    await originationControllerSTIRFRY.deployed();

    // admin whitelists MockERC20s on OriginationController
    const whitelistCurrency = await originationHelpers.setAllowedPayableCurrencies([USDC.address], [{ isAllowed: true, minPrincipal: 1000000 }]);
    await whitelistCurrency.wait();
    const whitelistCurrency2 = await originationHelpers.setAllowedPayableCurrencies([sUSDe.address], [{ isAllowed: true, minPrincipal: ethers.utils.parseEther("1") }]);
    await whitelistCurrency2.wait();
    // verify the currencies are whitelisted
    const isWhitelisted = await originationHelpers.isAllowedCurrency(USDC.address);
    expect(isWhitelisted).to.be.true;
    const isWhitelisted2 = await originationHelpers.isAllowedCurrency(sUSDe.address);
    expect(isWhitelisted2).to.be.true;

    // admin whitelists pair for stirfry loans
    await originationControllerSTIRFRY.setPair(USDC.address, sUSDe.address, 1e12, true);
    // verify the pair is whitelisted
    const key = ethers.utils.solidityKeccak256(["address", "address", "uint256"], [USDC.address, sUSDe.address, 1e12]);
    const isPairWhitelisted = await originationControllerSTIRFRY.stirfryPairs(key);
    expect(isPairWhitelisted).to.be.true;

    // admin whitelists MockERC721 and vaultFactory on OriginationController
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
        originationControllerSTIRFRY.address,
    );
    await updateOriginationControllerPermissions.wait();

    return {
        originationHelpers,
        originationControllerSTIRFRY,
        repaymentController,
        feeController,
        USDC,
        sUSDe,
        vaultFactory,
        vault,
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

describe.only("OriginationControllerSTIRFRY", () => {
    describe("Borrower loan origination", () => {
        let ctx: TestContext;
        let verifier: ArcadeItemsVerifier;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { user, originationHelpers, lenderPromissoryNote, borrowerPromissoryNote } = ctx;

            verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await originationHelpers.connect(user).setAllowedVerifiers([verifier.address], [true]);

            expect(await lenderPromissoryNote.totalSupply()).to.eq(0);
            expect(await borrowerPromissoryNote.totalSupply()).to.eq(0);
        });

        it("lender with 1,000,000 variable rate sUSDe locking in fixed rate of 15%", async () => {
            const { vaultFactory, originationControllerSTIRFRY, loanCore, USDC, sUSDe, user: lender, other: borrower } = ctx;

            // Lender has 1,000,000 sUSDe they want to lock in a fixed rate of 15% APR on
            await mint(sUSDe, lender, ethers.utils.parseEther("1000000"));

            // Lender creates vault and deposits 1,000,000 sUSDe into it
            const bundleId = await initializeBundle(vaultFactory, lender);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            await sUSDe.connect(lender).transfer(bundleAddress, ethers.utils.parseEther("1000000"));

            // Loan terms
            const loanTerms = createLoanTerms(
                USDC.address, vaultFactory.address, {
                    collateralId: bundleId,
                    principal: BigNumber.from(1000000000000), //  (1,000,000 USDC)
                    interestRate: BigNumber.from(1500), // 15% interest amount makes the repayment amount 1,150,000 USDC after 1 year
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            // lender signs CWO
            // the collection wide offer specifies that the vault must hold the total 'fixed' amount of 575,000 sUSDe
            // NOTE: way to check that sig items are same as the terms, new verifier, no terms?
            // whitelisting?
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: sUSDe.address,
                    tokenId: 0,
                    amount: ethers.utils.parseEther("1150000"),
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
                originationControllerSTIRFRY.address,
                "OriginationControllerSTIRFRY",
                loanTerms,
                predicates,
                lender,
                "1",
                defaultSigProperties,
                "l",
            );

            // lender approves sUSDe vault for loan
            await vaultFactory.connect(lender).approve(originationControllerSTIRFRY.address, bundleId);

            // borrower approves 150,000 sUSDe to the origination controller
            await mint(sUSDe, borrower, ethers.utils.parseEther("150000"));
            await sUSDe.connect(borrower).approve(originationControllerSTIRFRY.address, ethers.utils.parseEther("150000"));

            // Borrower initiates loan
            const stirfryData: StirfryData = {
                vaultedCurrency: sUSDe.address,
                borrowerVaultedCurrencyAmount: ethers.utils.parseEther("150000"),
                lenderVaultedCurrencyAmount: ethers.utils.parseEther("1000000"),
                vaultedToPayableCurrencyRatio: ethers.utils.parseEther("1").div(BigNumber.from(1000000)),
            }
            await expect(
                originationControllerSTIRFRY
                    .connect(borrower)
                    .initializeStirfryLoan(
                        loanTerms,
                        stirfryData,
                        borrower.address,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(vaultFactory, "Transfer")
                .withArgs(lender.address, loanCore.address, bundleId);

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(0);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(0);

            // check USDC balance of borrower and lender
            expect(await USDC.balanceOf(borrower.address)).to.equal(0);
            expect(await USDC.balanceOf(lender.address)).to.equal(0);

            // check loan core is the owner of the vault
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);
        })

        it("lender with 1,000,000 variable rate sUSDe locking in fixed rate of 15%, borrower repays loan", async () => {
            const { vaultFactory, originationControllerSTIRFRY, loanCore, USDC, sUSDe, user: lender, other: borrower, blockchainTime, repaymentController } = ctx;

            // Lender has 1,150,000 sUSDe they want to lock in a fixed rate of 15% APR on
            await mint(sUSDe, lender, ethers.utils.parseEther("1150000"));

            // Borrower creates vault and deposits 150,000 sUSDe into it
            const bundleId = await initializeBundle(vaultFactory, lender);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);

            // lender adds their sUSDe to their vault
            await sUSDe.connect(lender).transfer(bundleAddress, ethers.utils.parseEther("1150000"));

            // Loan terms
            const loanTerms = createLoanTerms(
                USDC.address, vaultFactory.address, {
                    collateralId: bundleId,
                    principal: ethers.utils.parseUnits("1000000", 6), //  (1,000,000 USDC)
                    interestRate: BigNumber.from(1500), // 15% interest amount makes the repayment amount 1,150,000 USDC after 1 year
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            // lender signs CWO
            // the collection wide offer specifies that the vault must hold the total 'fixed' amount of 575,000 sUSDe
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: sUSDe.address,
                    tokenId: 0,
                    amount: ethers.utils.parseEther("1150000"),
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
                originationControllerSTIRFRY.address,
                "OriginationControllerSTIRFRY",
                loanTerms,
                predicates,
                lender,
                "1",
                defaultSigProperties,
                "l",
            );

            // lender approves sUSDe vault for loan
            await vaultFactory.connect(lender).approve(originationControllerSTIRFRY.address, bundleId);

            // borrower approves 150,000 sUSDe to the origination controller
            await mint(sUSDe, borrower, ethers.utils.parseEther("150000"));
            await sUSDe.connect(borrower).approve(originationControllerSTIRFRY.address, ethers.utils.parseEther("150000"));

            // Borrower initiates loan
            const stirfryData: StirfryData = {
                vaultedCurrency: sUSDe.address,
                borrowerVaultedCurrencyAmount: ethers.utils.parseEther("150000"),
                lenderVaultedCurrencyAmount: ethers.utils.parseEther("1000000"),
                vaultedToPayableCurrencyRatio: ethers.utils.parseEther("1").div(BigNumber.from(1000000)),
            }
            await expect(
                originationControllerSTIRFRY
                    .connect(borrower)
                    .initializeStirfryLoan(
                        loanTerms,
                        stirfryData,
                        borrower.address,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(vaultFactory, "Transfer")
                .withArgs(lender.address, loanCore.address, bundleId);

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(0);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(0);

            // check USDC balance of borrower and lender
            expect(await USDC.balanceOf(borrower.address)).to.equal(0);
            expect(await USDC.balanceOf(lender.address)).to.equal(0);

            // check loan core is the owner of the vault
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            // fast forward to the end of the loan
            await blockchainTime.increaseTime(BigNumber.from(loanTerms.durationSecs).toNumber());

            // mint borrower 1,150,000 USDC
            await mint(USDC, borrower, ethers.utils.parseUnits("1150000", 6));
            await USDC.connect(borrower).approve(loanCore.address, ethers.utils.parseUnits("1150000", 6));

            // check USDC balance of borrower and lender
            expect(await USDC.balanceOf(borrower.address)).to.equal(ethers.utils.parseUnits("1150000", 6));
            expect(await USDC.balanceOf(lender.address)).to.equal(0);

            // borrower calls repayFull
            expect(await repaymentController.connect(borrower).repayFull(1))
                .to.emit(loanCore, "LoanRepaid").withArgs(1);

            // check USDC balance of borrower and lender
            expect(await USDC.balanceOf(borrower.address)).to.equal(0);
            expect(await USDC.balanceOf(lender.address)).to.equal(ethers.utils.parseUnits("1150000", 6));

            // check owner of the vault is the borrower
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(borrower.address);
        })

        it("lender with 1,000,000 variable rate sUSDe locking in fixed rate of 15%, borrower defaults", async () => {
            const { vaultFactory, originationControllerSTIRFRY, loanCore, USDC, sUSDe, user: lender, other: borrower, blockchainTime, repaymentController } = ctx;

            // Lender has 1,150,000 sUSDe they want to lock in a fixed rate of 15% APR on
            await mint(sUSDe, lender, ethers.utils.parseEther("1150000"));

            // Borrower creates vault and deposits 150,000 sUSDe into it
            const bundleId = await initializeBundle(vaultFactory, lender);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);

            // lender adds their sUSDe to their vault
            await sUSDe.connect(lender).transfer(bundleAddress, ethers.utils.parseEther("1150000"));

            // Loan terms
            const loanTerms = createLoanTerms(
                USDC.address, vaultFactory.address, {
                    collateralId: bundleId,
                    principal: BigNumber.from(1000000000000), //  (1,000,000 USDC)
                    interestRate: BigNumber.from(1500), // 15% interest amount makes the repayment amount 1,150,000 USDC after 1 year
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            // lender signs CWO
            // the collection wide offer specifies that the vault must hold the total 'fixed' amount of 575,000 sUSDe
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: sUSDe.address,
                    tokenId: 0,
                    amount: ethers.utils.parseEther("1150000"),
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
                originationControllerSTIRFRY.address,
                "OriginationControllerSTIRFRY",
                loanTerms,
                predicates,
                lender,
                "1",
                defaultSigProperties,
                "l",
            );

            // lender approves sUSDe vault for loan
            await vaultFactory.connect(lender).approve(originationControllerSTIRFRY.address, bundleId);

            // borrower approves 150,000 sUSDe to the origination controller
            await mint(sUSDe, borrower, ethers.utils.parseEther("150000"));
            await sUSDe.connect(borrower).approve(originationControllerSTIRFRY.address, ethers.utils.parseEther("150000"));

            // Borrower initiates loan
            const stirfryData: StirfryData = {
                vaultedCurrency: sUSDe.address,
                borrowerVaultedCurrencyAmount: ethers.utils.parseEther("150000"),
                lenderVaultedCurrencyAmount: ethers.utils.parseEther("1000000"),
                vaultedToPayableCurrencyRatio: ethers.utils.parseEther("1").div(BigNumber.from(1000000)),
            }
            await expect(
                originationControllerSTIRFRY
                    .connect(borrower)
                    .initializeStirfryLoan(
                        loanTerms,
                        stirfryData,
                        borrower.address,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(vaultFactory, "Transfer")
                .withArgs(lender.address, loanCore.address, bundleId);

            // check sUSDe balance of borrower and lender
            expect(await sUSDe.balanceOf(borrower.address)).to.equal(0);
            expect(await sUSDe.balanceOf(lender.address)).to.equal(0);

            // check USDC balance of borrower and lender
            expect(await USDC.balanceOf(borrower.address)).to.equal(0);
            expect(await USDC.balanceOf(lender.address)).to.equal(0);

            // check loan core is the owner of the vault
            expect(await vaultFactory.ownerOf(bundleId)).to.equal(loanCore.address);

            // fast forward to the end of the loan
            await blockchainTime.increaseTime(BigNumber.from(loanTerms.durationSecs).add(60 * 10).toNumber());

            // borrower defaults
            expect(await repaymentController.connect(lender).claim(1))
                .to.emit(loanCore, "LoanClaimed").withArgs(1);

            expect(await vaultFactory.ownerOf(bundleId)).to.eq(lender.address);
        })
    });
});
