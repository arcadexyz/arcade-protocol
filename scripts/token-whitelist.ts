import { ethers} from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import assert from "assert";
import fetch from "node-fetch";

import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../test/utils/constants";
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

async function handleRequest() {
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

    // create an array of 50 is allowed = true
    let isAllowed: boolean[] = [];
    for (let i = 0; i < 50; i++) {
        isAllowed.push(true);
    }

    const ORIGINATION_CONTROLLER = "0xbbBC439b5F1BD1a7321D15FD6fFcC9220c3E4282"; // from deployment sepolia-1684350326.json
    const originationControllerFact = await ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>await originationControllerFact.attach(ORIGINATION_CONTROLLER);

    // make the API call
    await handleRequest();

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
        // call txn to whitelist the less than 50 items
        await originationController.connect(signers[0]).setAllowedCollateralAddresses(whitelistingArr, isAllowed);

        amountToWhitelist -= amountToWhitelist;
    }

    // confirm that each item in the confirmWhitelist array has been whitelisted
    for (let i = 0; i < confirmWhitelist.length; i++) {
        // confirm
        const isWhitelisted = await originationController.allowedCollateral(confirmWhitelist[i]);
        // log item status
        console.log(`Collateral address: "${confirmWhitelist[i]}", is whiteListed = ${isWhitelisted}`);
        console.log(i);
    }

    console.log(SECTION_SEPARATOR);

    // whitelist ERC20 Tokens


    console.log(SECTION_SEPARATOR);

    // deployer revokes WHITELIST_MANAGER_ROLE

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

