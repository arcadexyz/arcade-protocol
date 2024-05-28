import hre, { ethers } from "hardhat";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms, SignatureProperties } from "../../test/utils/types";
import { EIP712_VERSION } from "../../test/utils/constants";

import { main as deploy } from "../deploy/deploy";
import { doWhitelisting } from "../deploy/whitelisting";
import { setupRoles } from "../deploy/setup-roles";
import { SECTION_SEPARATOR } from "../utils/constants";

import { ERC20, ERC721 } from "../../typechain";

// currencies for rollover
const DAIAddress = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // Mainnet DAI address
const WETHAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // Mainnet WETH address
const DECIMALS = 18;

// actors
const DAI_WHALE = "0xFCF05380255a7C7EC5F0AA28970c2dDf5aFee4fD";
const WETH_WHALE = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const ETH_WHALE = "0xd9858d573A26Bca124282AfA21ca4f4A06EfF98A";
const BORROWER = "0xAaf7cd37c3B353c9570f791c0877f57C2a9b3236";

// 0.3% Uniswap pool fee tier
const poolFeeTier = 3000;

/**
 * To run:
 * `FORK_MAINNET=true npx hardhat run scripts/rollover/cross-currency-rollover.ts`
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

    const {
        borrowerNote,
        lenderNote,
        originationController,
        crossCurrencyRollover,
    } = resources;

    const erc20Factory = await ethers.getContractFactory("ERC20");
    const dai = <ERC20>erc20Factory.attach(DAIAddress);
    const weth = <ERC20>erc20Factory.attach(WETHAddress);

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
    console.log("Original Lender: ", originalLender.address);
    console.log("New Lender: ", newLender.address);

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
        value: ethers.utils.parseEther("0.5"),
    });

    await whale.sendTransaction({
        to: WETH_WHALE,
        value: ethers.utils.parseEther("0.5"),
    });

    await whale.sendTransaction({
        to: newLender.address,
        value: ethers.utils.parseEther("0.5"),
    });

    // fund borrower with some DAI
    const daiAmount = ethers.utils.parseUnits("10000", DECIMALS); // 10,000 DAI
    await dai.connect(daiWhale).transfer(originalLender.address, daiAmount);

    // fund new lender with some WETH
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

    console.log("Approvals...");

    const approveDaiTx = await dai.connect(originalLender).approve(originationController.address, daiAmount);
    await approveDaiTx.wait();

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

    console.log("Migrate loan from DAI currency to WETH currency ...");

    // Calculate amount owed to original lender in the new currency:
    // (PRINCIPAL + Interest rate ) / swap rate.
    const interestAmount = await crossCurrencyRollover.calculateProratedInterestAmount(1);

    const amountOwed = PRINCIPAL.add(interestAmount);
    console.log("Total Amount Owed = Principal + Interest: ", ethers.utils.formatUnits(amountOwed, 18));

    // price of Dai in wETH
    const price = await crossCurrencyRollover.fetchCurrentPrice(DAIAddress, WETHAddress, 3000);
    console.log("Price of Dai in wETH: ", ethers.utils.formatUnits(price, 18));

    // amount owed in wETH
    let NEW_PRINCIPAL = amountOwed.mul(price).div(ethers.utils.parseUnits("1", 18));

    // account for 3% slippage
    const slippage = NEW_PRINCIPAL.mul(3).div(100);
    // NEW_PRINCIPAL + slippage amount for swap
    NEW_PRINCIPAL = NEW_PRINCIPAL.add(slippage);
    console.log("Amount Owed in New Currency Including Slippage: ", ethers.utils.formatUnits(NEW_PRINCIPAL, 18));

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
        crossCurrencyRollover.address,
        "OriginationController",
        newLoanTerms,
        newLender,
        EIP712_VERSION,
        sigProperties,
        "l",
    );

    console.log("Approvals for new loan...");
    // new lender approves WETH amount to contract
    const approveWETHTx = await weth.connect(newLender).approve(crossCurrencyRollover.address, wethAmount);
    await approveWETHTx.wait();

    // borrower approves borrower note
    await borrowerNote.connect(borrower).approve(crossCurrencyRollover.address, 1);

    await crossCurrencyRollover
        .connect(borrower)
        .rolloverCrossCurrencyLoan(
            1,
            newLoanTerms,
            newLender.address,
            newLenderSig,
            sigProperties,
            [],
            poolFeeTier
    );

    console.log();
    console.log("✅ Loan rolled over to new currency!");
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