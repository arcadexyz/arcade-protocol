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

} from "../typechain";
import { approve, mint } from "./utils/erc20";
import { BlockchainTime } from "./utils/time";
import { Borrower, LoanData, LoanTerms, SignatureProperties } from "./utils/types";
import { createLoanTermsSignature } from "./utils/eip712";
import { initializeBundle } from "./utils/loans";

import {
    ORIGINATOR_ROLE,
    ADMIN_ROLE,
    WHITELIST_MANAGER_ROLE,
    BASE_URI,
    MIN_LOAN_PRINCIPAL,
    EIP712_VERSION
} from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    originationController: OriginationController;
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
    describe("refinance active loan", () => {
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

        it.only("Refinance loan with nothing owed to borrower", async () => {
            const { originationController, loanCore, mockERC20, vaultFactory, lender, borrower, newLender, blockchainTime, } = ctx;

            const bundleId = await initializeBundle(vaultFactory, borrower);
            const loanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId });
            await mint(mockERC20, lender, loanTerms.principal);

            const sig = await createLoanTermsSignature(
                originationController.address,
                "OriginationController",
                loanTerms,
                lender,
                EIP712_VERSION,
                defaultSigProperties,
                "l",
            );

            await approve(mockERC20, lender, originationController.address, loanTerms.principal);
            await vaultFactory.connect(borrower).approve(originationController.address, bundleId);


            await originationController
                .connect(borrower)
                .initializeLoan(loanTerms, borrowerStruct, lender.address, sig, defaultSigProperties, []);

            // fast forward 2 days
            await blockchainTime.increaseTime(60 * 60 * 24 * 2);

            // get loan data
            const loanData: LoanData = await loanCore.getLoan(1);

            // refinance loan terms
            const refiLoanTerms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: bundleId, interestRate: BigNumber.from(500) });

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
            expect(
                await loanCore.connect(newLender).refinance(1, refiLoanTerms)
            ).to.emit(loanCore, "LoanRefinanced");
        });
    });
});
