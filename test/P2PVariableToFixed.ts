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
    ArcadeItemsVerifier,
    FeeController,
    UnvaultedItemsVerifier,
    CollectionWideOfferVerifier,
    BaseURIDescriptor,
    OriginationHelpers,
    MockERC20WithDecimals,
    RepaymentController
} from "../typechain";
import { approve, mint } from "./utils/erc20";
import { mint as mint721 } from "./utils/erc721";
import { Borrower, ItemsPredicate, LoanTerms, SignatureItem, SignatureProperties } from "./utils/types";
import { createLoanTermsSignature, createLoanItemsSignature } from "./utils/eip712";
import { encodeSignatureItems, initializeBundle } from "./utils/loans";

import {
    ORIGINATOR_ROLE,
    BASE_URI,
    MIN_LOAN_PRINCIPAL,
    EIP712_VERSION,
    REPAYER_ROLE
} from "./utils/constants";
import { BlockchainTime } from "./utils/time";

type Signer = SignerWithAddress;

interface TestContext {
    originationHelpers: OriginationHelpers;
    originationController: OriginationController;
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
    const OriginationControllerFactory = await ethers.getContractFactory("OriginationController",
        {
            signer: signers[0],
            libraries: {
                OriginationLibrary: originationLibrary.address,
            },
        },
    );
    const originationController = <OriginationController>(
        await OriginationControllerFactory.deploy(originationHelpers.address, loanCore.address, feeController.address)
    );
    await originationController.deployed();

    // admin whitelists MockERC20s on OriginationController
    const whitelistCurrency = await originationHelpers.setAllowedPayableCurrencies([USDC.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    await whitelistCurrency.wait();
    const whitelistCurrency2 = await originationHelpers.setAllowedPayableCurrencies([sUSDe.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]);
    await whitelistCurrency2.wait();
    // verify the currencies are whitelisted
    const isWhitelisted = await originationHelpers.isAllowedCurrency(USDC.address);
    expect(isWhitelisted).to.be.true;
    const isWhitelisted2 = await originationHelpers.isAllowedCurrency(sUSDe.address);
    expect(isWhitelisted2).to.be.true;

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
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    return {
        originationHelpers,
        originationController,
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

describe.only("P2PVariableToFixed", () => {
    describe("P2PVariableToFixed POC variants", () => {
        let ctx: TestContext;
        let verifier: ArcadeItemsVerifier;
        let borrowerStruct: Borrower;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            const { user, originationHelpers, other: borrower } = ctx;

            verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await originationHelpers.connect(user).setAllowedVerifiers([verifier.address], [true]);

            borrowerStruct = {
                borrower: borrower.address,
                callbackData: "0x"
            };
        });

        it("lender with variable rate sUSDe locking in fixed rate", async () => {
            const { vaultFactory, originationController, loanCore, USDC, sUSDe, user: lender, other: borrower } = ctx;

            // Lender has 1,000,000 sUSDe
            await mint(sUSDe, lender, ethers.utils.parseEther("1000000"));

            // Borrower creates vault and deposits 1,150,000 USDC into it
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            await mint(USDC, borrower, ethers.utils.parseEther("1150000"));
            await USDC.connect(borrower).transfer(bundleAddress, ethers.utils.parseEther("1150000"));

            // Lender signs CWO saying they want to lock in a fixed rate of 15% APR on their 1 million sUSDe
            // Principal amount for loan is 1,000,000 sUSDe
            // Borrower's collateral is 1,150,000 USDC in a vault
            // Repayment amount after 1yr is 1,150,000 sUSDe
            const loanTerms = createLoanTerms(
                sUSDe.address, vaultFactory.address, {
                    collateralId: bundleId,
                    principal: ethers.utils.parseEther("1000000"), // 1 million sUSDe
                    interestRate: BigNumber.from(1500), // 15% APR
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: USDC.address,
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
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // Lender approves sUSDe principal amount
            await approve(sUSDe, lender, originationController.address, loanTerms.principal);
            // Borrower approves USDC vault for loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            // Borrower initiates loan
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(sUSDe, "Transfer")
                .withArgs(lender.address, borrower.address, loanTerms.principal)
                .to.emit(vaultFactory, "Transfer")
                .withArgs(borrower.address, loanCore.address, bundleId);


            // Borrower now has 1,000,000 sUSDe for which they can collect yield on for the duration of the loan
            // The borrower is betting that the yield is greater than the 150,000 USDC they put up for collateral
            // The lender is betting that the borrower earns less than 150,000 sUSDe in yield for the duration of the loan
        })

        it("lender with variable rate sUSDe locking in fixed rate, borrower repays loan", async () => {
            const { vaultFactory, originationController, repaymentController, loanCore, USDC, sUSDe, user: lender, other: borrower, blockchainTime } = ctx;

            // Lender has 1,000,000 sUSDe
            await mint(sUSDe, lender, ethers.utils.parseEther("1000000"));

            // Borrower creates vault and deposits 1,150,000 USDC into it
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            await mint(USDC, borrower, ethers.utils.parseEther("1150000"));
            await USDC.connect(borrower).transfer(bundleAddress, ethers.utils.parseEther("1150000"));

            // Lender signs CWO saying they want to lock in a fixed rate of 15% APR on their 1 million sUSDe
            // Principal amount for loan is 1,000,000 sUSDe
            // Borrower's collateral is 1,150,000 USDC in a vault
            // Repayment amount after 1yr is 1,150,000 sUSDe
            const loanTerms = createLoanTerms(
                sUSDe.address, vaultFactory.address, {
                    collateralId: bundleId,
                    principal: ethers.utils.parseEther("1000000"), // 1 million sUSDe
                    interestRate: BigNumber.from(1500), // 15% APR
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: USDC.address,
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
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // Lender approves sUSDe principal amount
            await approve(sUSDe, lender, originationController.address, loanTerms.principal);
            // Borrower approves USDC vault for loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            // Borrower initiates loan
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(sUSDe, "Transfer")
                .withArgs(lender.address, borrower.address, loanTerms.principal)
                .to.emit(vaultFactory, "Transfer")
                .withArgs(borrower.address, loanCore.address, bundleId);


            // Borrower repays 1,150,000 sUSDe loan after 1 year
            await mint(sUSDe, borrower, ethers.utils.parseEther("150000"));
            await sUSDe.connect(borrower).approve(loanCore.address, ethers.utils.parseEther("1150000"));

            await blockchainTime.increaseTime(60 * 60 * 24 * 365);

            await expect(
                repaymentController.connect(borrower).repay(1, ethers.utils.parseEther("1150000"))
            )
            .to.emit(loanCore, "LoanRepaid").withArgs(1)
            .to.emit(sUSDe, "Transfer").withArgs(borrower.address, loanCore.address, ethers.utils.parseEther("1150000"))
            .to.emit(sUSDe, "Transfer").withArgs(loanCore.address, lender.address, ethers.utils.parseEther("1150000"));
        })

        it("lender with variable rate sUSDe locking in fixed rate, borrower defaults", async () => {
            const { vaultFactory, originationController, repaymentController, loanCore, USDC, sUSDe, user: lender, other: borrower, blockchainTime } = ctx;

            // Lender has 1,000,000 sUSDe
            await mint(sUSDe, lender, ethers.utils.parseEther("1000000"));

            // Borrower creates vault and deposits 1,150,000 USDC into it
            const bundleId = await initializeBundle(vaultFactory, borrower);
            const bundleAddress = await vaultFactory.instanceAt(bundleId);
            await mint(USDC, borrower, ethers.utils.parseEther("1150000"));
            await USDC.connect(borrower).transfer(bundleAddress, ethers.utils.parseEther("1150000"));

            // Lender signs CWO saying they want to lock in a fixed rate of 15% APR on their 1 million sUSDe
            // Principal amount for loan is 1,000,000 sUSDe
            // Borrower's collateral is 1,150,000 USDC in a vault
            // Repayment amount after 1yr is 1,150,000 sUSDe
            const loanTerms = createLoanTerms(
                sUSDe.address, vaultFactory.address, {
                    collateralId: bundleId,
                    principal: ethers.utils.parseEther("1000000"), // 1 million sUSDe
                    interestRate: BigNumber.from(1500), // 15% APR
                    durationSecs: BigNumber.from(60 * 60 * 24 * 365), // 1 year
                },
            );
            const signatureItems: SignatureItem[] = [
                {
                    cType: 2,
                    asset: USDC.address,
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
                originationController.address,
                "OriginationController",
                loanTerms,
                predicates,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            // Lender approves sUSDe principal amount
            await approve(sUSDe, lender, originationController.address, loanTerms.principal);
            // Borrower approves USDC vault for loan
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);

            // Borrower initiates loan
            await expect(
                originationController
                    .connect(borrower)
                    .initializeLoan(
                        loanTerms,
                        borrowerStruct,
                        lender.address,
                        sig,
                        defaultSigProperties,
                        predicates
                    ),
            )
                .to.emit(sUSDe, "Transfer")
                .withArgs(lender.address, borrower.address, loanTerms.principal)
                .to.emit(vaultFactory, "Transfer")
                .withArgs(borrower.address, loanCore.address, bundleId);


            // Borrower defaults, lender claims 1,150,000 USDC in vault
            await blockchainTime.increaseTime(60 * 60 * 24 * 365 + (60 * 10));

            await expect(
                repaymentController.connect(lender).claim(1)
            )
            .to.emit(loanCore, "LoanClaimed").withArgs(1)
            .to.emit(vaultFactory, "Transfer").withArgs(loanCore.address, lender.address, bundleId);
        })
    });
});
