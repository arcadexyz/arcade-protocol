import { ethers} from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import assert from "assert";
import fetch from "node-fetch";
import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "./utils/constants";
import { NETWORK } from "./deploy/test/utils";
import { WHITELIST_MANAGER_ROLE } from "./utils/constants";

import { OriginationController } from "../typechain";

/**
 * Live data for approved collections on Arcade: https://api.arcade.xyz/api/v2/collections/
 * API details: https://docs.arcade.xyz/reference/get_api-v2-collections
 */

/**
 * Note: Against normal conventions, these tests are interdependent and meant
 * to run sequentially. Each subsequent test relies on the state of the previous.
 */
assert(NETWORK !== "hardhat", "Must use a long-lived network!");

let addressVerified: string[] = [];
let verifiedAmount: number;

async function getVerifiedTokenData() {
    try {
        const apiURL = `https://api.arcade.xyz/api/v2/collections/?isVerified=true`;
        const resp = await fetch(apiURL, {
            method: "GET",
            headers: {
                "Content-type": "application/json",
                "X-Auth-Token": `${process.env.ARCADE_API_KEY}`,
            },
        });

        const data = await resp.json();
        verifiedAmount = data.length;
        console.log("Number of Dapp Approved Collections:", verifiedAmount);

        // get the collection ids
        data.forEach((collection: any) => addressVerified.push(collection.id));

        console.log(SUBSECTION_SEPARATOR);

       return;
    } catch (error) {
        console.error(error);
    }
}

export async function main(): Promise<void> {
    let whitelistingArr: string[] = [];
    let confirmWhitelist: string[] = [];
    const signers: SignerWithAddress[] = await ethers.getSigners();

    const WETH = ethers.utils.getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    const WBTC = ethers.utils.getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
    const USDC = ethers.utils.getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    const USDT = ethers.utils.getAddress("0xdac17f958d2ee523a2206206994597c13d831ec7");
    const DAI = ethers.utils.getAddress("0x6B175474E89094C44Da98b954EedeAC495271d0F");
    const APE = ethers.utils.getAddress("0x4d224452801ACEd8B2F0aebE155379bb5D594381");
    const allowedCurrencies = [WETH, WBTC, USDC, USDT, DAI, APE];

    const ORIGINATION_CONTROLLER = "0xad9A60B116F7004de62D3942ed668AFD29E66534"; // from deployment sepolia-1684446603.json
    const originationControllerFact = await ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>await originationControllerFact.attach(ORIGINATION_CONTROLLER);

    // make the API call
    await getVerifiedTokenData();

    // create an array of 50 isAllowed = true because that is the max allowable
    // in the setAllowedCollateralAddresses parameter arrays
    let isAllowed: boolean[] = [];
    for (let i = 0; i < 50; i++) {
        isAllowed.push(true);
    }

    // NFT Collection WHITELISTING
    // setAllowedCollateralAddresses takes 50 addresses max
    // so api data needs to be divided into batches of 50 for whitelisting
    let amountToWhitelist = Math.ceil(addressVerified.length * 100) / 100;
    while (amountToWhitelist > 0) {
        while (amountToWhitelist > 50) {
            // push 50 items from addressVerified to whitelistingArr and delete what is pushed from addressesWhitelist
            for (let i = 0; i < 50; i++) {
                let item = addressVerified.splice(0, 1)[0]; // Remove the first item from addressVerified
                item = ethers.utils.getAddress(item); // format it into an address
                whitelistingArr.push(item); // push it into the array for the whitelisting txn
                confirmWhitelist.push(item); // also push it into the array for confirming the whitelist
            }

            // call txn to whitelist the 50 items
            await originationController.connect(signers[0]).setAllowedCollateralAddresses(whitelistingArr, isAllowed);

            // zero out the whitelisting array so it can receive the next 50 addresses
            whitelistingArr.length = 0;
            // subtract 50 from amountToWhitelist array
            amountToWhitelist -= 50;
        }

        for (let i = 0; i < amountToWhitelist; i++) {
            let item = addressVerified.splice(0, 1)[0]; // Remove the first item from addressVerified
            item = ethers.utils.getAddress(item); // format it into an address
            whitelistingArr.push(item); // Push the formatted item into the array for the whitelisting txn
            confirmWhitelist.push(item); // Push the formatted item into the array for confirming the whitelist
        }

        // reset isAllowed to match the lenght of whitelistingArr
        isAllowed.length = 0;
        for (let i = 0; i < whitelistingArr.length; i++) {
            isAllowed.push(true);
        }
        // call txn to whitelist remaining items
        await originationController.connect(signers[0]).setAllowedCollateralAddresses(whitelistingArr, isAllowed);

        amountToWhitelist -= amountToWhitelist;
    }

    // confirm that each item in the confirmWhitelist array has been whitelisted
    for (let i = 0; i < confirmWhitelist.length; i++) {
        // confirm
        const isWhitelisted = await originationController.allowedCollateral(confirmWhitelist[i]);
        // log item status
        console.log(`Collateral address: "${confirmWhitelist[i]}", is whiteListed = ${isWhitelisted}`);
        console.log(`${i}`);
    }

    console.log(`${confirmWhitelist.length} Collections have been whitelisted`);
    console.log(SECTION_SEPARATOR);

    // Payable Currency WHITELISTING
    // reset isAllowed to match the length of allowedCurrencies
    isAllowed.length = 0;
    for (let i = 0; i < allowedCurrencies.length; i++) {
        isAllowed.push(true);
    }

    // whitelist ERC20 Tokens
    await originationController.connect(signers[0]).setAllowedPayableCurrencies(allowedCurrencies, isAllowed);

    // confirm that each item in the allowedCurrencies array has been whitelisted
    for (let i = 0; i < allowedCurrencies.length; i++) {
        const isCurrencyWhitelisted = await originationController.isAllowedCurrency(allowedCurrencies[i]);
        // log item status
        console.log(`Currency address: "${allowedCurrencies[i]}", is whiteListed = ${isCurrencyWhitelisted}`);
    }

    console.log("Payable Currencies: WETH, WBTC, USDC, USDT, DAI, APE are whitelisted");
    console.log(SECTION_SEPARATOR);

    // deployer revokes WHITELIST_MANAGER_ROLE
    const renounceOriginationControllerWhiteListManager = await originationController.renounceRole(
        WHITELIST_MANAGER_ROLE,
        signers[0].address,
    );
    await renounceOriginationControllerWhiteListManager.wait();
    console.log("OriginationController: deployer has renounced WHITELIST_MANAGER_ROLE");
    console.log(SECTION_SEPARATOR);

    return;
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

