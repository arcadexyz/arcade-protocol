import hre, { ethers } from "hardhat";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms, SignatureProperties } from "../../test/utils/types";

import { ERC20 } from "../../typechain";

import { main as deploy } from "../deploy/deploy";
import { doWhitelisting } from "../deploy/whitelisting";
import { setupRoles } from "../deploy/setup-roles";

import { SECTION_SEPARATOR } from "../utils/constants";
import { BasicOrderParameters, encodeBasicOrderSeaportV2 } from "./seaport-types";
import { BigNumber, BytesLike } from "ethers";

export interface MarketplaceData {
    marketplace: string;
    listPrice: BigNumber;
    data: BytesLike;
}

// marketplace
const SEAPORT = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"; // Seaport 1.5

// loan payable currency
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DECIMALS = 18;

// collateral
const ON1_Force = "0x3bf2922f4520a8BA0c2eFC3D2a1539678DaD5e9D";
const ON1_Force_ID = 3033;

// actors
const BORROWER = "0xcffc336e6d019c1af58257a0b10bf2146a3f42a4";
const MARKETPLACE_SELLER = "0x1c4fb6616e0bbf548ad8575ae2d16413642da1d1";
const USDC_WHALE = "0x72A53cDBBcc1b9efa39c834A540550e23463AAcB";
const WETH_WHALE = "0x57757E3D981446D585Af0D9Ae4d7DF6D64647806";


// v4 loan terms
const newLoanTerms: LoanTerms = {
    interestRate: 1000,
    durationSecs: 3600,
    collateralAddress: ON1_Force,
    deadline: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    payableCurrency: WETH,
    principal: ethers.utils.parseUnits("1", DECIMALS), // 1 WETH
    collateralId: ON1_Force_ID,
    affiliateCode: ethers.constants.HashZero,
};
const sigProperties: SignatureProperties = {
    nonce: 1,
    maxUses: 1,
};

// Seaport offer
// https://etherscan.io/tx/0x77b89241e360849771d8b55dcdb7c603407b5c7dedba82a849fdf65f57805f15
const SEAPORT_ORDER: BasicOrderParameters = {
    considerationToken: ethers.constants.AddressZero,
    considerationIdentifier: BigNumber.from(0),
    considerationAmount: ethers.utils.parseEther("1.0438545"),
    offerer: MARKETPLACE_SELLER,
    zone: "0x004c00500000ad104d7dbd00e3ae0a5c00560c00",
    offerToken: ON1_Force,
    offerIdentifier: BigNumber.from(ON1_Force_ID),
    offerAmount: BigNumber.from(1),
    basicOrderType: 0,
    startTime: 1706088103,
    endTime: 1708678630,
    zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    salt: "51951570786726798460324975021501917861654789585098516727718557743326050217544",
    offererConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    fulfillerConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    totalOriginalAdditionalRecipients: BigNumber.from(1),
    additionalRecipients: [
        {
            amount: ethers.utils.parseEther("0.0052455"),
            recipient: "0x0000a26b00c1F0DF003000390027140000fAa719"
        }
    ],
    signature: "0x0180d0ccad81c68c9bdd773417914c66e5122c4958c3c1651256b6d145a561700b1b798109066b6b3a5597aeb759ff5dbe9f8dd11759bb539dddd763523800b1"
};


/**
 * This is a mainnet fork script used the SmartBorrowerBNPL.sol contract to buy an asset from OpenSea
 * and take out a loan against it.
 *
 * To run:
 * `FORK_MAINNET=true npx hardhat run scripts/bnpl/execute-bnpl-seaport.ts`
 *
 * Ensure the hardhat.config.ts file is configured correctly to fork at `blockNumber: 19075770`
 */
export async function main(): Promise<void> {
    const resources = await deploy();
    console.log("V4 contracts deployed!");

    await doWhitelisting(resources);
    console.log("V4 whitelisting complete!");

    await setupRoles(resources);
    console.log("V4 contracts setup!");

    const { originationController, loanCore, borrowerNote, lenderNote } = resources;

    const erc20Factory = await ethers.getContractFactory("ERC20");
    const payableCurrency = <ERC20>erc20Factory.attach(WETH);

    // deploy SmartBorrowerBNPL.sol
    const borrowerFactory = await ethers.getContractFactory("SmartBorrowerBNPL");
    const borrowerContract = await borrowerFactory.deploy(
        originationController.address,
        loanCore.address,
        borrowerNote.address
    );
    await borrowerContract.deployed();
    console.log("SmartBorrowerBNPL deployed to:", borrowerContract.address);

    // whitelist Blur marketplace address
    await borrowerContract.setApprovedMarketplace(SEAPORT, true);

    console.log(SECTION_SEPARATOR);

    console.log("Encoding blur order...");
    const takeAskSingleCalldata = encodeBasicOrderSeaportV2(SEAPORT_ORDER);
    // get initializeLoan function selector
    const takeAskSingleSelector = "0xfb0f3ee1";
    // append calldata to initializeLoan function selector
    const calldataWithSelector = takeAskSingleSelector + takeAskSingleCalldata.slice(2);
    // console.log("Calldata with selector: ", calldataWithSelector);

    console.log(SECTION_SEPARATOR);

    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [BORROWER],
    });
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [WETH_WHALE],
    });
    const whale = await ethers.getSigner(WETH_WHALE);
    const borrower = await ethers.getSigner(BORROWER);
    console.log("V3 Borrower: ", borrower.address);

    const [newLender] = await ethers.getSigners();
    console.log("New Lender: ", newLender.address);
    console.log();

    console.log("Execute BNPL...");

    // new lender signs a bid on v4
    const newLoanTermsSignature = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        newLoanTerms,
        newLender,
        "4",
        sigProperties,
        "l",
    );

    const marketplaceData: MarketplaceData = {
        marketplace: SEAPORT,
        listPrice: SEAPORT_ORDER.considerationAmount.add(SEAPORT_ORDER.additionalRecipients[0].amount),
        data: calldataWithSelector,
    }
    // encode marketplace data
    const marketplaceDataEncoded = ethers.utils.defaultAbiCoder.encode(
        [ // types
            "tuple(address marketplace, uint256 listPrice, bytes data)",
        ],
        [ // values
            marketplaceData,
        ]
    );

    await whale.sendTransaction({ to: newLender.address, value: ethers.utils.parseEther(".5") });

    // new lender approves v4 origination controller to spend new loan terms principal
    await payableCurrency.connect(whale).transfer(newLender.address, newLoanTerms.principal);
    await payableCurrency.connect(newLender).approve(originationController.address, newLoanTerms.principal);

    // borrower approves difference of purchase amount and new terms principal to be pulled by bnpl contract
    const borrowerOwes = marketplaceData.listPrice.sub(newLoanTerms.principal);
    if (borrowerOwes.gt(0)) {
        await payableCurrency.connect(whale).transfer(borrower.address, borrowerOwes);
        await payableCurrency.connect(borrower).approve(borrowerContract.address, borrowerOwes);
    }

    const sellerBalanceBefore = await payableCurrency.balanceOf(MARKETPLACE_SELLER);
    console.log("Seller balance before migration: ", ethers.utils.formatUnits(sellerBalanceBefore, DECIMALS));
    const borrowerBalanceBefore = await payableCurrency.balanceOf(BORROWER);
    console.log("Borrower balance before migration: ", ethers.utils.formatUnits(borrowerBalanceBefore, DECIMALS));
    const v4LenderBalanceBefore = await payableCurrency.balanceOf(newLender.address);
    console.log("V4 Lender balance before migration: ", ethers.utils.formatUnits(v4LenderBalanceBefore, DECIMALS));
    const ocBalanceBefore = await payableCurrency.balanceOf(originationController.address);
    console.log("V4 OriginationController balance before migration: ", ethers.utils.formatUnits(ocBalanceBefore, DECIMALS));
    console.log();

    // borrower calls executeBNPL
    await borrowerContract.connect(borrower).initializeLoan(
        newLoanTerms,
        marketplaceDataEncoded,
        newLender.address,
        newLoanTermsSignature,
        sigProperties,
        []
    );

    const sellerBalanceAfter = await payableCurrency.balanceOf(MARKETPLACE_SELLER);
    console.log("Seller balance after migration: ", ethers.utils.formatUnits(sellerBalanceAfter, DECIMALS));
    const borrowerBalanceAfter = await payableCurrency.balanceOf(BORROWER);
    console.log("Borrower balance after migration: ", ethers.utils.formatUnits(borrowerBalanceAfter, DECIMALS));
    const v4LenderBalanceAfter = await payableCurrency.balanceOf(newLender.address);
    console.log("V4 Lender balance after migration: ", ethers.utils.formatUnits(v4LenderBalanceAfter, DECIMALS));
    const ocBalanceAfter = await payableCurrency.balanceOf(originationController.address);
    console.log("V4 OriginationController balance after migration: ", ethers.utils.formatUnits(ocBalanceAfter, DECIMALS));
    console.log();

    console.log("Seller net: ", ethers.utils.formatUnits(sellerBalanceAfter.sub(sellerBalanceBefore), DECIMALS));
    console.log("Borrower net: ", ethers.utils.formatUnits(borrowerBalanceAfter.sub(borrowerBalanceBefore), DECIMALS));
    console.log("V4 Lender net: ", ethers.utils.formatUnits(v4LenderBalanceAfter.sub(v4LenderBalanceBefore), DECIMALS));
    console.log("V4 OriginationController net: ", ethers.utils.formatUnits(ocBalanceAfter.sub(ocBalanceBefore), DECIMALS));
    console.log();

    const borrowerNoteOwner = await borrowerNote.ownerOf(1);
    console.log("Borrower Note owner: ", borrowerNoteOwner);
    const lenderNoteOwner = await lenderNote.ownerOf(1);
    console.log("Lender Note owner: ", lenderNoteOwner);
    console.log();

    // const loanData = await loanCore.getLoan(1);
    // console.log("Loan data: ", loanData);

    console.log(SECTION_SEPARATOR);
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