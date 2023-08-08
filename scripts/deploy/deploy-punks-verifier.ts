import hre, { ethers } from "hardhat";
import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../utils/bootstrap-tools";

import { PunksVerifier } from "../../typechain";

export interface DeployedResources {
    verifier: PunksVerifier;
}

export async function main(): Promise<DeployedResources> {
    // Hardhat always runs the compile task when running scripts through it.
    // If this runs in a standalone fashion you may want to call compile manually
    // to make sure everything is compiled
    // await run("compile");

    console.log(SECTION_SEPARATOR);

    const PUNKS_ADDRESS = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB";

    const VerifierFactory = await ethers.getContractFactory("PunksVerifier");
    const verifier = <PunksVerifier>await VerifierFactory.deploy(PUNKS_ADDRESS);
    await verifier.deployed();

    console.log("PunksVerifier deployed to:", verifier.address);

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
