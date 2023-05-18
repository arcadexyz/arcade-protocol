import fs from "fs";
import hre from "hardhat";
import { BigNumberish } from "ethers";

import { ContractData } from "./write-json";

import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../utils/constants";

async function verifyArtifacts(
    contractName: string,
    contractAddress: string,
    constructorArgs: BigNumberish[],
) {
    console.log(`${contractName}: ${contractAddress}`);
    console.log(SUBSECTION_SEPARATOR);

    try {
        await hre.run("verify:verify", {
            address: contractAddress,
            constructorArguments: constructorArgs,
        });
    } catch (err) {
        if (!err.message.match(/already verified/i)) {
            throw err;
        } else {
            console.log("\nContract already verified.");
        }
    }

    console.log(`${contractName}: ${contractAddress}`, "has been verified.");
    console.log(SECTION_SEPARATOR);
}

// get data from deployments json to run verify artifacts
export async function main(): Promise<void> {
    // retrieve command line args array
    const [,,file] = process.argv;

    // read deployment json to get contract addresses and constructor arguments
    const readData = fs.readFileSync(file, 'utf-8');
    const jsonData = JSON.parse(readData);

    // loop through jsonData to run verifyArtifacts function
    for (const property in jsonData) {
        const dataFromJson = <ContractData>jsonData[property];

        await verifyArtifacts(
            property,
            dataFromJson.contractAddress,
            dataFromJson.constructorArgs,
        );
    }
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
