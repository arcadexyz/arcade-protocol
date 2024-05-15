import hre, { ethers } from "hardhat";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms, SignatureProperties } from "../../test/utils/types";
import { createVault } from "../utils/vault";

import { Signer, Contract, BigNumber } from "ethers";
import { SECTION_SEPARATOR } from "../utils/constants";
import { main as deploy } from "../deploy/deploy";
import { doWhitelisting } from "../deploy/whitelisting";
import { setupRoles } from "../deploy/setup-roles";
import { EIP712_VERSION } from "../../test/utils/constants";

import {
    OriginationLibrary,
    ERC20,
    OriginationControllerMigrate
} from "../../typechain";

// UniswapV3 contract addresses
const uniswapV3FactoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // UniswapV3 Factory address on mainnet
const swapRouterAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // UniswapV3 Swap Router address on mainnet

// currencies to migrate to // TODO: MAKE A SWAP TO A DIFFERENT DECIMAL CURRENCY
const DAIAddress = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // Mainnet DAI address
const WETHAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // Mainnet WETH address
const DECIMALS = 18;

// actors
const DAI_WHALE = "0xFCF05380255a7C7EC5F0AA28970c2dDf5aFee4fD"; // 0x48e36ECf3C403f899d2BB09b00CC1443FF7e3D33 //0xFCF05380255a7C7EC5F0AA28970c2dDf5aFee4fD
const WETH_WHALE = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const ETH_WHALE = "0xd9858d573A26Bca124282AfA21ca4f4A06EfF98A";
const BORROWER = "0x6C2D65145B14978a95D14c8dDc5415d9FC447910"; // https://opensea.io/lank
const DEPLOYER = "0x6c6F915B21d43107d83c47541e5D29e872d82Da6";
const USDC_WHALE = "0x72A53cDBBcc1b9efa39c834A540550e23463AAcB";

/**
 * To run:
 * `FORK_MAINNET=true npx hardhat run scripts/currency-migration/migrate-currency.ts`
 */

export async function main(): Promise<void> {
    const resources = await deploy();
    console.log("V4 contracts deployed!");

    await doWhitelisting(resources);
    console.log("V4 whitelisting complete!");

    await setupRoles(resources);
    console.log("V4 contracts setup!");

    console.log(SECTION_SEPARATOR);

    const {
        loanCore,
        feeController,
        borrowerNote,
        repaymentController,
        originationHelpers,
        originationController,
        vaultFactory,
    } = resources;

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

    // await hre.network.provider.request({
    //     method: "hardhat_impersonateAccount",
    //     params: [WETH_WHALE],
    // });

    console.log(SECTION_SEPARATOR);

    const whale = await ethers.getSigner(ETH_WHALE);
    const borrower = await ethers.getSigner(BORROWER);
    const daiWhale = await ethers.getSigner(DAI_WHALE);
    const wethhale = await ethers.getSigner(WETH_WHALE);

    console.log("Borrower address: ", borrower.address);

    const [originalLender] = await ethers.getSigners();
    console.log("Original Currency Loan Lender: ", originalLender.address);

    // const [newLender] = await ethers.getSigners();
    // console.log("New Currency Loan Lender: ", newLender.address);

    // fund the borrower with some ETH
    await whale.sendTransaction({
        to: BORROWER,
        value: ethers.utils.parseEther("0.5"),
    });

    // fund the  original lender with some ETH
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

    console.log("Sending DAI from DAI whale to the original lender...");

    // Check DAI whale balance
    const daiWhaleBalance = await dai.balanceOf(daiWhale.address);
    console.log(`DAI whale balance: ${ethers.utils.formatUnits(daiWhaleBalance, DECIMALS)} DAI`);

    // transfer DAI from whale to borrower
    const daiAmount = ethers.utils.parseUnits("1000", DECIMALS); // 1000 DAI
    await dai.connect(daiWhale).transfer(originalLender.address, daiAmount);

    console.log(
        `Original lender DAI balance: ${ethers.utils.formatUnits(
            await dai.balanceOf(originalLender.address),
            DECIMALS,
        )} DAI`,
    );

    // // fund the  new lender with some ETH
    // await ethWhale.sendTransaction({
    //     to: newLender.address,
    //     value: ethers.utils.parseEther("0.5"),
    // });

    ////////////////////// CREATE THE ORIGINAL V4 LOAN //////////////////////////////////////////////
    const INTEREST_RATE = 500; // 5%
    const AMOUNT = 10;
    const PRINCIPAL = ethers.utils.parseEther(AMOUNT.toString());
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

    // const sig = await createLoanTermsSignature(
    //     originationController.address,
    //     "OriginationController",
    //     originalLoanTerms,
    //     borrower,
    //     EIP712_VERSION,
    //     sigProperties,
    //     "b",
    // );

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

    console.log("Approving...");

    const vault = await createVault(vaultFactory, borrower);

    const approveVaultTx = await vaultFactory
        .connect(borrower)
        .approve(originationController.address, vault.address);
    await approveVaultTx.wait();

    console.log("Approving DAI...");

    const approveDaiTx = await dai
        .connect(originalLender)
        .approve(originationController.address, daiAmount);
    await approveDaiTx.wait();

    const currentAllowance = await dai.allowance(originalLender.address, originationController.address);
    console.log(`Current allowance: ${ethers.utils.formatUnits(currentAllowance, DECIMALS)} DAI`);

    await originationController
        .connect(borrower)
        .initializeLoan(originalLoanTerms, borrowerStruct, originalLender.address, originalSig, sigProperties, []);


    console.log(
        `User ${borrower.address} borrowed ${AMOUNT} DAI at 15% interest from ${originalLender.address} against Vault ${vault.address}`,
    );
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