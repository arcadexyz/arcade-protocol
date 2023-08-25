import hre, { ethers } from "hardhat";
import { loadContracts, Depl, DeployedResourcesoyedResources } from "../utils/deploy";

import { BALANCER_ADDRESS } from "./config";
import { V2ToV3Rollover, V2ToV3RolloverWithItems } from "../../typechain";

export async function deploy(resources: DeployedResources): Promise<void> {
    const args = [
        BALANCER_ADDRESS,
        {
            feeControllerV3: resources.feeController.address,
            originationControllerV3: resources.originationController.address,
            loanCoreV3: resources.loanCore.address,
            borrowerNoteV3: resources.borrowerNote.address
        }
    ];

    const rolloverBaseFactory = await ethers.getContractFactory("V2ToV3Rollover");
    const rolloverWithItemsFactory = await ethers.getContractFactory("V2ToV3RolloverWithItems");

    const rollover = <V2ToV3Rollover>await rolloverBaseFactory.deploy(...args);
    const rolloverWithItems = <V2ToV3RolloverWithItems>await rolloverWithItemsFactory.deploy(...args);
    await Promise.all([rollover.deployed(), rolloverWithItems.deployed()]);

    console.log();
    console.log("V2ToV3Rollover deployed to:", rollover.address);
    console.log("V2ToV3RolloverWithItems deployed to:", rolloverWithItems.address);

    console.log("\nPaste into deployments JSON:");
    console.log(JSON.stringify({
        V2ToV3Rollover: {
            contractAddress: rollover.address,
            constructorArgs: args
        },
        V2ToV3RolloverWithItems: {
            contractAddress: rolloverWithItems.address,
            constructorArgs: args
        }
    }, null, 4));
    console.log("\n");

    if (process.env.VERIFY) {
        await hre.run("verify:verify", {
            address: rollover.address,
            constructorArguments: args
        });

        await hre.run("verify:verify", {
            address: rolloverWithItems.address,
            constructorArguments: args
        });
    }
}

if (require.main === module) {
    // retrieve command line args array
    const file = process.env.DEPLOYMENT_FILE;

    console.log("File:", file);

    // assemble args to access the relevant deplyment json in .deployment
    void loadContracts(file!)
        .then(deploy)
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
