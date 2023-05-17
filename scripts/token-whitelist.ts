import fs from "fs"
import hre, { ethers, artifacts} from "hardhat";
import { BigNumberish, Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import assert from "assert";
import fetch from "node-fetch";

import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../test/utils/constants";

import { getLatestDeployment, getVerifiedABI, NETWORK } from "./deploy/test/utils";

import { WHITELIST_MANAGER_ROLE } from "./utils/constants";

/**
 * Live data for approved collections on Arcade: https://api.arcade.xyz/api/v2/collections/
 * API instructions: https://docs.arcade.xyz/reference/get_api-v2-collections
 */

/**
 * Note: Against normal conventions, these tests are interdependent and meant
 * to run sequentially. Each subsequent test relies on the state of the previous.
 */
//assert(NETWORK !== "hardhat", "Must use a long-lived network!");

import {
    OriginationController
} from "../typechain";


interface CollectionData {
    isVerified: boolean;
    id: string;
    name: string;
    kind: string;
    openseaSlug: string;
    isNotable: boolean;
    isCWOffersEnabled: boolean;
    previewTokenIds: [];
}

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
    const signers: SignerWithAddress[] = await ethers.getSigners();
    const WHITELIST_MANAGER = signers[0];

    // create an array of 50 is allowed = true
    const isAllowed: boolean[] = [];
    for (let i = 0; i < 51; i++) {
        isAllowed.push(true);
    }

    const ORIGINATION_CONTROLLER = "0xad1e10fd728dc3264a382715decc6984ba6178cd";
    const originationControllerFact = await hre.ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>await originationControllerFact.attach(ORIGINATION_CONTROLLER);

    // const originationControllerAbi = await getVerifiedABI(originationControllerAddress);
    // const provider = new ethers.providers.JsonRpcProvider(
    //     `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
    // );
    // console.log(originationControllerAddress);
    // console.log(originationControllerAbi);
    // // get the originationController
    // let originationController: Contract = new ethers.Contract(
    //     originationControllerAddress,
    //     originationControllerAbi,
    //     provider
    // );

    // make the API call
    await handleRequest();

    // repeat the process until addressVerified array contains 0 items
    // dividing by 50 because setAllowedCollateralAddresses takes 50 addresses max
    //for (let i = addressVerified.length / 50; i > 0; i--) {
    // push 50 items from addressVerified to whitelistingArr and delete them from addressesWhitelist
    for (let i = 0; i < 50; i++) {
        const item = addressVerified.splice(0, 1)[0]; // Remove the first item from addressVerified
        whitelistingArr.push(item); // Push the item into whitelistingArr
    }

    // whitelist every 50 items
    await originationController.setAllowedCollateralAddresses(whitelistingArr, isAllowed);
    // and confirm that each collateral address has been whitelisted
    let i = 0;
    // confirm and log each item being whitelisted
    const isWhitelisted = await originationController.allowedCollateral(whitelistingArr[i]);
    console.log(`Collateral address: ${whitelistingArr[i]}, is whiteListed = ${isWhitelisted}`);
    i++;
    console.log(i);
    console.log(SUBSECTION_SEPARATOR);
    // whitelistingArr.forEach(async (item: BigNumberish) => {
    //     console.log("0. whitelistingArr FOR EACH", item);
    //     let i = 0;
    //     // confirm and log each item being whitelisted
    //     await originationController.allowedCollateral(whitelistingArr[i]);
    //     console.log(`Whitelisted collateral address:", ${whitelistingArr[i]}`);
    //     i++;
    //     console.log(i);
    // });
    //([whitelistingArr], [isAllowed]);
    // make whitelistingArr empty to receive another 50 addresses
    //whitelistingArr.length = 0;
    //}

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

