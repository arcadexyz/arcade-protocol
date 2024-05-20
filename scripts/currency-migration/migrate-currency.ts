import hre, { ethers } from "hardhat";
import { ContractTransaction } from "ethers";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms, SignatureProperties } from "../../test/utils/types";

import { main as deploy } from "../deploy/deploy";
import { doWhitelisting } from "../deploy/whitelisting";
import { setupRoles } from "../deploy/setup-roles";
import { EIP712_VERSION } from "../../test/utils/constants";

import {
    ORIGINATOR_ROLE,
    ADMIN_ROLE,
    ADMIN,
    SUBSECTION_SEPARATOR,
    SECTION_SEPARATOR,
    MIGRATION_MANAGER_ROLE,
    MIGRATION_MANAGER,
} from "../utils/constants";

import {
    OriginationLibrary,
    ERC20,
    ERC721
} from "../../typechain";


const swapRouterAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // UniswapV3 Swap Router address on mainnet

// currencies to migrate to
const DAIAddress = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // Mainnet DAI address
const WETHAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // Mainnet WETH address
const DECIMALS = 18;

// actors
const DAI_WHALE = "0xFCF05380255a7C7EC5F0AA28970c2dDf5aFee4fD";
const WETH_WHALE = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const ETH_WHALE = "0xd9858d573A26Bca124282AfA21ca4f4A06EfF98A";
const BORROWER = "0xAaf7cd37c3B353c9570f791c0877f57C2a9b3236";
const DEPLOYER = "0x6c6F915B21d43107d83c47541e5D29e872d82Da6";

/**
 * To run:
 * `FORK_MAINNET=true npx hardhat run scripts/currency-migration/migrate-currency.ts`
 * use block number: 19884656
 */

async function advanceTime(seconds: number): Promise<void> {
    await hre.network.provider.send("evm_increaseTime", [seconds]);
    await hre.network.provider.send("evm_mine");
}

export async function main(): Promise<void> {
    const resources = await deploy();
    console.log("V4 contracts deployed!");

    await doWhitelisting(resources);
    console.log("V4 whitelisting complete!");

    await setupRoles(resources);
    console.log("V4 contracts setup!");

    console.log(SECTION_SEPARATOR);

    const { loanCore, feeController, borrowerNote, lenderNote, repaymentController, originationHelpers, originationController } =
        resources;

    const erc20Factory = await ethers.getContractFactory("ERC20");
    const dai = <ERC20>erc20Factory.attach(DAIAddress);
    const weth = <ERC20>erc20Factory.attach(WETHAddress);

    const OriginationLibraryFactory = await ethers.getContractFactory("OriginationLibrary");
    const originationLibrary = <OriginationLibrary>await OriginationLibraryFactory.deploy();

    // deploy the currency migration contract
    const OriginationControllerCurrencyMigrateFactory = await ethers.getContractFactory(
        "OriginationControllerCurrencyMigrate",
        {
            libraries: {
                OriginationLibrary: originationLibrary.address,
            },
        },
    );

    const originationControllerCurrencyMigrate = await OriginationControllerCurrencyMigrateFactory.deploy(
        originationHelpers.address,
        loanCore.address,
        borrowerNote.address,
        repaymentController.address,
        feeController.address,
        swapRouterAddress,
    );
    await originationControllerCurrencyMigrate.deployed();

    console.log("OriginationControllerCurrencyMigrate address: ", originationControllerCurrencyMigrate.address);
    console.log(SECTION_SEPARATOR);

    let tx: ContractTransaction;
    tx = await loanCore.grantRole(ORIGINATOR_ROLE, originationControllerCurrencyMigrate.address);
    await tx.wait();
    tx = await originationControllerCurrencyMigrate.grantRole(ADMIN_ROLE, ADMIN);
    await tx.wait();
    tx = await originationControllerCurrencyMigrate.grantRole(MIGRATION_MANAGER_ROLE, MIGRATION_MANAGER);
    await tx.wait();
    tx = await originationControllerCurrencyMigrate.renounceRole(ADMIN_ROLE, DEPLOYER);
    await tx.wait();
    tx = await originationControllerCurrencyMigrate.renounceRole(MIGRATION_MANAGER_ROLE, DEPLOYER);
    await tx.wait();

    console.log(`ORIGINATOR ROLE ${ORIGINATOR_ROLE}`);

    console.log(`OriginationControllerCurrencyMigrate: admin role granted to ${ADMIN}`);
    console.log(`OriginationControllerCurrencyMigrate: migration manager role granted to ${MIGRATION_MANAGER}`);
    console.log(`OriginationControllerCurrencyMigrate: Deployer renounced admin and migration manager role`);
    console.log(SUBSECTION_SEPARATOR);

    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [BORROWER],
    });

    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [ETH_WHALE],
    });

    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [DAI_WHALE],
    });

    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [WETH_WHALE],
    });

    console.log(SECTION_SEPARATOR);

    const whale = await ethers.getSigner(ETH_WHALE);
    const borrower = await ethers.getSigner(BORROWER);
    const daiWhale = await ethers.getSigner(DAI_WHALE);
    const wethWhale = await ethers.getSigner(WETH_WHALE);

    console.log("Borrower address: ", borrower.address);

    const [originalLender, newLender] = await ethers.getSigners();
    console.log("Original Loan Lender: ", originalLender.address);
    console.log("New Loan Lender: ", newLender.address);

    // fund the accounts with ETH
    await whale.sendTransaction({
        to: BORROWER,
        value: ethers.utils.parseEther("0.5"),
    });

    await whale.sendTransaction({
        to: originalLender.address,
        value: ethers.utils.parseEther("0.5"),
    });

    await whale.sendTransaction({
        to: DAI_WHALE,
        value: ethers.utils.parseEther("0.1"),
    });

    await whale.sendTransaction({
        to: WETH_WHALE,
        value: ethers.utils.parseEther("0.1"),
    });

    await whale.sendTransaction({
        to: newLender.address,
        value: ethers.utils.parseEther("0.5"),
    });

    // fund borrower with some DAI
    const daiAmount = ethers.utils.parseUnits("10000", DECIMALS); // 10,000 DAI
    await dai.connect(daiWhale).transfer(originalLender.address, daiAmount);

    // transfer WETH from whale to new lender
    const wethAmount = ethers.utils.parseUnits("5000", DECIMALS); // 5,000 WETH
    await weth.connect(wethWhale).transfer(newLender.address, wethAmount);

    ////////////////////// CREATE THE ORIGINAL V4 LOAN //////////////////////////////////////////////
    const INTEREST_RATE = 1500; // 15%
    const PRINCIPAL = ethers.utils.parseUnits("3000", 18); // 3000 DAI
    const ORIGINAL_PAYABLE_CURRENCY = DAIAddress;
    const NEW_PAYABLE_CURRENCY = WETHAddress;
    const COLLATERAL_ID = 2438;
    const COLLATERAL_ADDRESS = "0xd774557b647330c91bf44cfeab205095f7e6c367"; // NAKAMIGOS
    const AFFILIATE_CODE = ethers.constants.HashZero;
    const DURATION_SECS = 60 * 60 * 24 * 30; // 30 days

    const originalLoanTerms: LoanTerms = {
        interestRate: INTEREST_RATE,
        durationSecs: DURATION_SECS,
        collateralAddress: COLLATERAL_ADDRESS,
        deadline: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        payableCurrency: ORIGINAL_PAYABLE_CURRENCY,
        principal: PRINCIPAL,
        collateralId: COLLATERAL_ID,
        affiliateCode: AFFILIATE_CODE,
    };

    const borrowerStruct = {
        borrower: BORROWER,
        callbackData: "0x",
    };

    const sigProperties: SignatureProperties = {
        nonce: 1,
        maxUses: 1,
    };

    // lender signs a bid for initial loan
    const originalSig = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        originalLoanTerms,
        originalLender,
        EIP712_VERSION,
        sigProperties,
        "l",
    );

    console.log("Approving DAI...");

    const approveDaiTx = await dai.connect(originalLender).approve(originationController.address, daiAmount);
    await approveDaiTx.wait();

    console.log("Approving NAKAMIGOS...");

    const erc721Factory = await ethers.getContractFactory("ERC721");
    const nakamigos = <ERC721>erc721Factory.attach(COLLATERAL_ADDRESS);

    const approveCollateralTx = await nakamigos.connect(borrower).approve(originationController.address, COLLATERAL_ID);
    await approveCollateralTx.wait();

    await originationController
        .connect(borrower)
        .initializeLoan(originalLoanTerms, borrowerStruct, originalLender.address, originalSig, sigProperties, []);

    console.log(
        `User ${borrower.address} borrowed ${PRINCIPAL} DAI at 15% interest from ${originalLender.address} against Nakamigos ${COLLATERAL_ID}`,
    );

    console.log(SECTION_SEPARATOR);

    // advance time by two weeks into loan
    await advanceTime(1209600); // 60 * 60 * 24 * 14

    ////////////////////// MIGRATE LOAN TO NEW CURRENCY //////////////////////////////////////////////

    console.log("Migrate loan from DAI to WETH ...");

    // Calculate amount owed in the new currency:
    // (PRINCIPAL + Interest rate ) / swap rate.
    const interestAmount = await originationControllerCurrencyMigrate.calculateProratedInterestAmount(1);
    console.log("Interest Owed: ", ethers.utils.formatUnits(interestAmount, 18));

    const amountOwed = PRINCIPAL.add(interestAmount);
    console.log("Total Amount Owed = Principal + Interest: ", ethers.utils.formatUnits(amountOwed, 18));

    // price of wETH in DAI
    const price = await originationControllerCurrencyMigrate._fetchCurrentPrice(DAIAddress, WETHAddress, 3000);

    // get the amount owed in the new currency
    const scaledPrice = price.div(ethers.BigNumber.from(`${1e18}`)); // price is in 18 decimals
    const NEW_PRINCIPAL = amountOwed.div(scaledPrice);
    console.log("Amount in New Currency Owed: ", ethers.utils.formatUnits(NEW_PRINCIPAL, 18));

    const newLoanTerms: LoanTerms = {
        interestRate: INTEREST_RATE,
        durationSecs: DURATION_SECS,
        collateralAddress: COLLATERAL_ADDRESS,
        deadline: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        payableCurrency: NEW_PAYABLE_CURRENCY,
        principal: NEW_PRINCIPAL,
        collateralId: COLLATERAL_ID,
        affiliateCode: AFFILIATE_CODE,
    };

    const newLenderSig = await createLoanTermsSignature(
        originationControllerCurrencyMigrate.address,
        "OriginationController",
        newLoanTerms,
        newLender,
        EIP712_VERSION,
        sigProperties,
        "l",
    );

    console.log("Approving WETH...");
    // new lender approves WETH amount to contract
    const approveWETHTx = await weth
        .connect(newLender)
        .approve(originationControllerCurrencyMigrate.address, wethAmount);
    await approveWETHTx.wait();

    // borrower approves borrower note
    await borrowerNote.connect(borrower).approve(originationControllerCurrencyMigrate.address, 1);

    // TODO: add pool fee to the function arguments
    await originationControllerCurrencyMigrate
        .connect(borrower)
        .migrateCurrencyLoan(1, newLoanTerms, newLender.address, NEW_PAYABLE_CURRENCY, newLenderSig, sigProperties, []);

    console.log();
    console.log("✅ Loan migrated to new currency!");
    console.log();

    // check the borrower and lender notes
    const newCurrencyLoanBorrower = await borrowerNote.ownerOf(2);
    console.log("newCurrencyLoanBorrower: ", newCurrencyLoanBorrower);
    const newCurrencyLoanLender = await lenderNote.ownerOf(2);
    console.log("newCurrencyLoanLender: ", newCurrencyLoanLender);
    if (newCurrencyLoanLender !== newLender.address) {
        throw new Error("New currency loan lender is not the same as new lender");
    }
    if (newCurrencyLoanBorrower !== borrower.address) {
        throw new Error("New currency loan borrower is not the same as borrower");
    }
    console.log();
    console.log("✅ Loan notes ownership confirmed!");
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}

 ///////////////////// SIMPLE SWAP EXAMPLE //////////////////////

    // // amount to swap

    // const amountIn = ethers.utils.parseEther("100"); // 100 DAI
    // // 0.3% pool fee
    // const fee = 3000;

    // await currencyIn.connect(lender).transfer(borrower.address, amountIn);
    // await currencyIn.connect(borrower).approve(originationControllerCurrencyMigrate.address, amountIn);

    // console.log("Borrower DAI balance: ", ethers.utils.formatEther(await currencyIn.balanceOf(borrower.address)));

    // // make the swap
    // // for the sake of simplicity, we set amountOutMinimum to 0, but this
    // // value should be calculated using the Uniswap SDK to protect
    // // against price manipulation.
    // await originationControllerCurrencyMigrate
    //     .connect(borrower)
    //     .swapExactInputSingle(DAIAddress, WETHAddress, amountIn, 0, fee, originationControllerCurrencyMigrate.address);

    // console.log(
    //     "CurrencyMigrate contract WETH balance: ",
    //     ethers.utils.formatEther(await currencyOut.balanceOf(originationControllerCurrencyMigrate.address)),
    // );