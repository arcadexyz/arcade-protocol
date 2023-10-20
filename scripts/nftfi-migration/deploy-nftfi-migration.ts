import hre, { ethers } from "hardhat";
import { loadContracts, DeployedResources } from "../utils/deploy";

import { BALANCER_ADDRESS, NFTFI_DIRECT_LOAN_COORDINATOR_ADDRESS, NFTFI_DIRECT_LOAN_FIXED_OFFER_ADDRESS } from "./config";
import { LP1Migration, LP1MigrationWithItems } from "../../typechain";

export async function deploy(resources: DeployedResources): Promise<void> {
    const args = [
        BALANCER_ADDRESS,
        {
            directLoanFixedOffer: NFTFI_DIRECT_LOAN_FIXED_OFFER_ADDRESS,
            loanCoordinator: NFTFI_DIRECT_LOAN_COORDINATOR_ADDRESS,
            feeControllerV3: resources.feeController.address,
            originationControllerV3: resources.originationController.address,
            loanCoreV3: resources.loanCore.address,
            borrowerNoteV3: resources.borrowerNote.address,
        },
    ];

    const migrationBaseFactory = await ethers.getContractFactory("LP1Migration");
    const migrationWithItemsFactory = await ethers.getContractFactory("LP1MigrationWithItems");

    const migration = <LP1Migration>await migrationBaseFactory.deploy(...args);
    await migration.deployed();
    const migrationWithItems = <LP1MigrationWithItems>await migrationWithItemsFactory.deploy(...args);
    await migrationWithItems.deployed();

    console.log();
    console.log("LP1Migration deployed to:", migration.address);
    console.log("LP1MigrationWithItems deployed to:", migrationWithItems.address);

    console.log("\nPaste into deployments JSON:");
    console.log(
        JSON.stringify(
            {
                LP1Migration: {
                    contractAddress: migration.address,
                    constructorArgs: args,
                },
                LP1MigrationWithItems: {
                    contractAddress: migrationWithItems.address,
                    constructorArgs: args,
                },
            },
            null,
            4,
        ),
    );
    console.log("\n");

    if (process.env.VERIFY) {
        await hre.run("verify:verify", {
            address: migration.address,
            constructorArguments: args,
        });

        await hre.run("verify:verify", {
            address: migrationWithItems.address,
            constructorArguments: args,
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
