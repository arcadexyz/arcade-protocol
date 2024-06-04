import hre, { ethers } from "hardhat";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms, SignatureProperties, SwapParameters } from "../../test/utils/types";
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
 * `FORK_MAINNET=true npx hardhat run scripts/rollover/cross-currency-rollover-same-lender.ts`
 * use block number: 19884656
 *
 * This script demonstrates a scenario where a loan is rolled over to a new currency
 * whose principal amount is insufficient to cover the original loan's required repayment
 * amount. Therefore the borrower must provide the difference to settle the full original
 * loan amount.
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

    const { borrowerNote, lenderNote, originationController, crossCurrencyRollover } = resources;

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

    const whale = await ethers.getSigner(ETH_WHALE);
    const borrower = await ethers.getSigner(BORROWER);
    const daiWhale = await ethers.getSigner(DAI_WHALE);
    const wethWhale = await ethers.getSigner(WETH_WHALE);
    const [lender] = await ethers.getSigners();

    console.log("Borrower address: ", borrower.address);
    console.log("Lender address: ", lender.address);

    // fund the accounts with ETH
    await whale.sendTransaction({
        to: BORROWER,
        value: ethers.utils.parseEther("0.5"),
    });

    await whale.sendTransaction({
        to: lender.address,
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

    // fund lender with some DAI
    const daiAmount = ethers.utils.parseUnits("10000", DECIMALS); // 10,000 DAI
    await dai.connect(daiWhale).transfer(lender.address, daiAmount);

    // fund lender with some WETH
    const wethAmount = ethers.utils.parseUnits("5000", DECIMALS); // 5,000 WETH
    await weth.connect(wethWhale).transfer(lender.address, wethAmount);

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
        maxUses: 2,
    };

    // lender signs a bid for initial loan
    const originalSig = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        originalLoanTerms,
        lender,
        EIP712_VERSION,
        sigProperties,
        "l",
    );

    console.log();
    console.log("Approvals...");

    const approveDaiTx = await dai.connect(lender).approve(originationController.address, daiAmount);
    await approveDaiTx.wait();

    const erc721Factory = await ethers.getContractFactory("ERC721");
    const nakamigos = <ERC721>erc721Factory.attach(COLLATERAL_ADDRESS);

    const approveCollateralTx = await nakamigos.connect(borrower).approve(originationController.address, COLLATERAL_ID);
    await approveCollateralTx.wait();

    // lender DAI balance before loan
    const lenderDAIBalanceBefore = await dai.balanceOf(lender.address);
    // borrower DAI balance before loan
    const borrowerDAIBalanceBefore = await dai.balanceOf(borrower.address);

    console.log("Initialize loan...");
    console.log();

    await originationController
        .connect(borrower)
        .initializeLoan(originalLoanTerms, borrowerStruct, lender.address, originalSig, sigProperties, []);

    // borrower DAI balance after loan
    const borrowerDAIBalanceAfter = await dai.balanceOf(borrower.address);
    // lender DAI balance after loan
    const lenderDAIBalanceAfter = await dai.balanceOf(lender.address);
    // lender DAI balance after loan is now less
    const expectedLenderBalance = lenderDAIBalanceBefore.sub(borrowerDAIBalanceAfter);
    // check if the lender's actual balance matches the expected balance
    const isLenderBalanceCorrect = lenderDAIBalanceAfter.eq(expectedLenderBalance);

    console.log("Lender DAI balance before loan: ", ethers.utils.formatUnits(lenderDAIBalanceBefore, 18));
    console.log("Borrower DAI balance before loan: ", ethers.utils.formatUnits(borrowerDAIBalanceBefore, 18));
    console.log(`Lender DAI balance after loan: ${ethers.utils.formatUnits(expectedLenderBalance, 18)} DAI`);
    console.log("Borrower DAI balance after loan: ", ethers.utils.formatUnits(borrowerDAIBalanceAfter, 18));
    console.log("Lender DAI balance is reduced correctly: ", isLenderBalanceCorrect);

    console.log();
    console.log(
        `User ${borrower.address} borrowed ${ethers.utils.formatUnits(PRINCIPAL, 18)} DAI at 15% interest from ${
            lender.address
        } against Nakamigos ${COLLATERAL_ID}`,
    );

    console.log(SECTION_SEPARATOR);

    // advance time by two weeks into loan
    await advanceTime(1209600); // 60 * 60 * 24 * 14

    ////////////////////// MIGRATE LOAN TO NEW CURRENCY //////////////////////////////////////////////
    console.log("Rollover loan from DAI to wETH ...");

    // Calculate amount owed to original lender in the new currency:
    // (PRINCIPAL + Interest rate ) / swap rate.
    const interestAmount = await crossCurrencyRollover.calculateProratedInterestAmount(1);
    const amountOwed = PRINCIPAL.add(interestAmount);
    console.log(
        "Total amount owed on original loan = Principal + Interest: ",
        ethers.utils.formatUnits(amountOwed, 18),
    );

    // price of Dai in wETH
    const price = await crossCurrencyRollover.fetchCurrentPrice(DAIAddress, WETHAddress, 3000);
    console.log("Price of DAI in wETH: ", ethers.utils.formatUnits(price, 18));
    // changing the value of NEW_PRINCIPAL will affect whether the borrower will
    // need to provide additional funds to pay the difference
    let NEW_PRINCIPAL = amountOwed.mul(price).div(ethers.utils.parseUnits("1", 18));

    // account for 3% slippage
    const slippage = NEW_PRINCIPAL.mul(3).div(100);
    // NEW_PRINCIPAL + slippage amount for swap
    NEW_PRINCIPAL = NEW_PRINCIPAL.add(slippage);
    console.log("Amount owed in new currency including 3% slippage: ", ethers.utils.formatUnits(NEW_PRINCIPAL, 18));

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

    const newSig = await createLoanTermsSignature(
        crossCurrencyRollover.address,
        "OriginationController",
        newLoanTerms,
        lender,
        EIP712_VERSION,
        sigProperties,
        "l",
    );

    const swapParams: SwapParameters = {
        minAmountOut: amountOwed.div(2),
        poolFeeTier: poolFeeTier,
    };

    console.log();
    console.log("Approvals for rollover loan...");

    // lender approves WETH amount to contract
    const approveWETHTx = await weth.connect(lender).approve(crossCurrencyRollover.address, wethAmount);
    await approveWETHTx.wait();

    // if new principal amount is less than the amount owed
    if (NEW_PRINCIPAL.lt(amountOwed)) {
        const borrowerOwed = amountOwed.sub(NEW_PRINCIPAL);

        // fund borrower with some DAI
        await dai.connect(daiWhale).transfer(borrower.address, borrowerOwed);

        // borrower approves DAI amount needed from borrower to contract
        const approveBorrowerDaiTx = await dai.connect(borrower).approve(crossCurrencyRollover.address, borrowerOwed);
        await approveBorrowerDaiTx.wait();
    }

    // borrower approves borrower note
    await borrowerNote.connect(borrower).approve(crossCurrencyRollover.address, 1);

    // lender wETH balance before loan
    const lenderWETHBalanceBefore = await weth.balanceOf(lender.address);

    console.log("Rollover cross currency loan...");
    console.log();

    await crossCurrencyRollover
        .connect(borrower)
        .rolloverCrossCurrencyLoan(1, newLoanTerms, lender.address, newSig, sigProperties, [], swapParams);

    console.log("✅ Loan rolled over to new currency!");
    console.log();

    // lender DAI balance after loan
    const lenderDAIBalanceAfterRollover = await dai.balanceOf(lender.address);
    // lender wETH balance after rollover
    const newLenderWETHBalanceAfter = await weth.balanceOf(lender.address);
    // lender wETH balance after rollover is now less
    const expectedLenderWethBalance = lenderWETHBalanceBefore.sub(NEW_PRINCIPAL);
    // check if the lender's actual wETH balance matches the expected balance
    const isLenderWethBalanceCorrect = newLenderWETHBalanceAfter.eq(expectedLenderWethBalance);

    console.log("Lender wETH balance before rollover: ", ethers.utils.formatUnits(lenderWETHBalanceBefore, 18));
    console.log("Lender DAI balance before rollover: ", ethers.utils.formatUnits(lenderDAIBalanceAfter, 18));
    console.log("Lender wETH balance after rollover: ", ethers.utils.formatUnits(newLenderWETHBalanceAfter, 18));
    console.log(
        "Lender DAI balance after rollover: ",
        ethers.utils.formatUnits(lenderDAIBalanceAfterRollover, 18),
    );
    console.log("Lender wETH balance is reduced correctly: ", isLenderWethBalanceCorrect);
    console.log();

    // check the borrower and lender notes
    const newCurrencyLoanBorrower = await borrowerNote.ownerOf(2);
    console.log("newCurrencyLoanBorrower: ", newCurrencyLoanBorrower);
    const newCurrencyLoanLender = await lenderNote.ownerOf(2);
    console.log("newCurrencyLoanLender: ", newCurrencyLoanLender);
    if (newCurrencyLoanLender !== lender.address) {
        throw new Error("New currency loan lender is not the same as original loan lender");
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
