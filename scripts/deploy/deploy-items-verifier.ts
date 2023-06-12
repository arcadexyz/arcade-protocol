import hre, { ethers } from "hardhat";
import { SECTION_SEPARATOR } from "../utils/constants";

import {
    ArcadeItemsVerifier
} from "../../typechain";

export interface DeployedResources {
    verifier: ArcadeItemsVerifier;
}

export async function main(): Promise<DeployedResources> {
    // Hardhat always runs the compile task when running scripts through it.
    // If this runs in a standalone fashion you may want to call compile manually
    // to make sure everything is compiled
    // await run("compile");

    console.log(SECTION_SEPARATOR);

    const VerifierFactory = await ethers.getContractFactory("ArcadeItemsVerifier");
    const verifier = <ArcadeItemsVerifier>await VerifierFactory.deploy();
    await verifier.deployed();

    console.log("ItemsVerifier deployed to:", verifier.address);

    return { verifier };
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
