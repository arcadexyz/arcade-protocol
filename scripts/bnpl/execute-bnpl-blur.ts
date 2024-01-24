import hre, { ethers } from "hardhat";

import { createLoanTermsSignature } from "../../test/utils/eip712";
import { LoanTerms, SignatureProperties } from "../../test/utils/types";

import { ERC20 } from "../../typechain";

import { main as deploy } from "../deploy/deploy";
import { doWhitelisting } from "../deploy/whitelisting";
import { setupRoles } from "../deploy/setup-roles";

import { SECTION_SEPARATOR } from "../utils/constants";
import { Order, TakeAsk, TakeAskSingle } from "./blur-types";
import { BigNumber, BytesLike } from "ethers";
import { blurV2Abi } from "./abis/marketplaces";

export interface MarketplaceData {
    marketplace: string;
    listPrice: BigNumber;
    data: BytesLike;
}

// marketplace
const BLEND = "0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5"; // blur proxy

// payable currency
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DECIMALS = 18;

// collateral
const MEEBITS = "0x7Bd29408f11D2bFC23c34f18275bBf23bB716Bc7";
const MEEBITS_ID = 2930;

// actors
const BORROWER = "0xcffc336e6d019c1af58257a0b10bf2146a3f42a4";
const BLUR_SELLER = "0xFEE2C0c52Eb0f05f3DCccCd0D857Bc0F3f9f6C94";
const USDC_WHALE = "0x72A53cDBBcc1b9efa39c834A540550e23463AAcB";
const WETH_WHALE = "0x57757E3D981446D585Af0D9Ae4d7DF6D64647806";


// v4 loan terms
const newLoanTerms: LoanTerms = {
    interestRate: 1000,
    durationSecs: 3600,
    collateralAddress: MEEBITS,
    deadline: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    payableCurrency: WETH,
    principal: ethers.utils.parseUnits("1", DECIMALS), // 1 WETH
    collateralId: MEEBITS_ID,
    affiliateCode: ethers.constants.HashZero,
};
const sigProperties: SignatureProperties = {
    nonce: 1,
    maxUses: 1,
};

// blur ask bid
const BLEND_ORDER: Order = {
    trader: BLUR_SELLER,
    collection: MEEBITS,
    listingsRoot: "0x6ac024163e947c1852286773166c012d3142cc385ebcb8e2446cbc2c3b946291",
    numberOfListings: 1,
    expirationTime: 1706027633,
    assetType: 0,
    makerFee: {
        recipient: "0xa858ddc0445d8131dac4d1de01f834ffcba52ef1",
        rate: 50,
    },
    salt: "113210315397381204266840672906428188837",
}

const BLEND_EXCHANGE = {
    index: 0,
    proof: [],
    listing: {
        index: 0,
        tokenId: 2930,
        amount: 1,
        price: ethers.utils.parseEther("1.22"),
    },
    taker: {
        tokenId: 2930,
        amount: 1,
    },
}

let TAKE_ASK_SINGLE: TakeAskSingle = {
    order: BLEND_ORDER,
    exchange: BLEND_EXCHANGE,
    takerFee: {
        recipient: "0x0000000000000000000000000000000000000000",
        rate: 0,
    },
    signature: "0x05d42247befafb0a7eb7da2d7867c675ca3554bbd74752467f86ef451a052537247257357002eb637b76e98c6f99536436c77cdbd6e71cf0a2ffcfdd827dcd111c",
    tokenRecipient: ethers.constants.AddressZero,
}

let TAKE_ASK: TakeAsk = {
    orders: [BLEND_ORDER],
    exchanges: [BLEND_EXCHANGE],
    takerFee: {
        recipient: "0x0000000000000000000000000000000000000000",
        rate: 0,
    },
    signatures: "0x05d42247befafb0a7eb7da2d7867c675ca3554bbd74752467f86ef451a052537247257357002eb637b76e98c6f99536436c77cdbd6e71cf0a2ffcfdd827dcd111c",
    tokenRecipient: ethers.constants.AddressZero,
}
/**
 * This is a mainnet fork script used the SmartBorrowerBNPL.sol contract to buy an asset from OpenSea
 * and take out a loan against it.
 *
 * To run:
 * `FORK_MAINNET=true npx hardhat run scripts/bnpl/execute-bnpl-blur.ts`
 *
 * Ensure the hardhat.config.ts file is configured correctly to fork at `blockNumber: 19070157`
 */
export async function main(): Promise<void> {
    const resources = await deploy();
    console.log("V4 contracts deployed!");

    await doWhitelisting(resources);
    console.log("V4 whitelisting complete!");

    await setupRoles(resources);
    console.log("V4 contracts setup!");

    const { originationController, loanCore, borrowerNote } = resources;

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

    const blurV2 = await ethers.getContractAt(blurV2Abi, BLEND);

    // whitelist Blur marketplace address
    await borrowerContract.setApprovedMarketplace(BLEND, true);

    // update TAKE_ASK_SINGLE recipient to borrower contract
    TAKE_ASK_SINGLE.tokenRecipient = borrowerContract.address;
    TAKE_ASK.tokenRecipient = borrowerContract.address;

    console.log(SECTION_SEPARATOR);

    console.log("Generating blur hash...");
    const oracleSig = await blurV2.hashTakeAskSingle(TAKE_ASK_SINGLE, borrowerContract.address);
    console.log("Oracle signature: ", oracleSig);

    console.log("Encoding blur order...");
    const takeAskSingleCalldata = ethers.utils.defaultAbiCoder.encode(
        [ // types
            "tuple(tuple(address, address, bytes32, uint256, uint256, uint8, tuple(address, uint16), uint256), tuple(uint256, bytes32[], tuple(uint256, uint256, uint256, uint256), tuple(uint256, uint256)), tuple(address, uint16), bytes, address)",
            "bytes",
        ],
        [ // values
            [
                [ // order
                    BLEND_ORDER.trader,
                    BLEND_ORDER.collection,
                    BLEND_ORDER.listingsRoot,
                    BLEND_ORDER.numberOfListings,
                    BLEND_ORDER.expirationTime,
                    BLEND_ORDER.assetType,
                    [
                        BLEND_ORDER.makerFee.recipient,
                        BLEND_ORDER.makerFee.rate,
                    ],
                    BLEND_ORDER.salt,
                ],
                [ // exchange
                    BLEND_EXCHANGE.index,
                    BLEND_EXCHANGE.proof,
                    [
                        BLEND_EXCHANGE.listing.index,
                        BLEND_EXCHANGE.listing.tokenId,
                        BLEND_EXCHANGE.listing.amount,
                        BLEND_EXCHANGE.listing.price,
                    ],
                    [
                        BLEND_EXCHANGE.taker.tokenId,
                        BLEND_EXCHANGE.taker.amount,
                    ],
                ],
                [ // takerFee
                    ethers.constants.AddressZero,
                    0,
                ],
                TAKE_ASK_SINGLE.signature,
                "0xa158ffb97cc5b65c7c762b31d3e8111688ee6940",
            ],
            oracleSig,
        ]
    );
    // get initializeLoan function selector
    const takeAskSingleSelector = "0x70bce2d6";
    // append calldata to initializeLoan function selector
    const calldataWithSelector = takeAskSingleSelector + takeAskSingleCalldata.slice(2);
    console.log("Calldata with selector: ", calldataWithSelector);

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
        marketplace: BLEND,
        listPrice: TAKE_ASK_SINGLE.exchange.listing.price,
        data: takeAskSingleCalldata,
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
    const borrowerOwes = TAKE_ASK_SINGLE.exchange.listing.price.sub(newLoanTerms.principal);
    if (borrowerOwes.gt(0)) {
        await payableCurrency.connect(whale).transfer(borrower.address, borrowerOwes);
        await payableCurrency.connect(borrower).approve(borrowerContract.address, borrowerOwes);
    }

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