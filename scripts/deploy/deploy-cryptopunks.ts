import { ethers } from "hardhat";
import { SECTION_SEPARATOR } from "../../test/utils/constants";

import {
    CryptoPunksMarket
} from "../../typechain";

export interface DeployedResources {
    punks: CryptoPunksMarket;
}

export async function main(): Promise<DeployedResources> {
    // Hardhat always runs the compile task when running scripts through it.
    // If this runs in a standalone fashion you may want to call compile manually
    // to make sure everything is compiled
    // await run("compile");

    console.log(SECTION_SEPARATOR);

    const CryptoPunksFactory = await ethers.getContractFactory("CryptoPunksMarket");
    const punks = <CryptoPunksMarket>await CryptoPunksFactory.deploy();
    await punks.deployed();

    console.log("CryptoPunks deployed to:", punks.address);

    return { punks };
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
