import hre, { ethers } from "hardhat";
import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../utils/bootstrap-tools";

import {
    CryptoPunksMarket
} from "../../typechain";

export interface DeployedResources {
    punks: CryptoPunksMarket;
}

export async function main(): Promise<void> {
    // Hardhat always runs the compile task when running scripts through it.
    // If this runs in a standalone fashion you may want to call compile manually
    // to make sure everything is compiled
    // await run("compile");

    console.log(SECTION_SEPARATOR);

    const signers = await ethers.getSigners();

    const LC_ADDRESS = "0x81b2F8Fc75Bab64A6b144aa6d2fAa127B4Fa7fD9";

    const LoanCoreFactory = await ethers.getContractFactory("LoanCore", signers[1]);
    // const setLockCalldata = LoanCoreFactory.interface.encodeFunctionData("setLock", []);

    // console.log("CALLDATA: ", setLockCalldata);

    const contract = await LoanCoreFactory.deploy();
    await contract.deployed();

    console.log("NEW IMPL ADDRESS: ", contract.address);
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
