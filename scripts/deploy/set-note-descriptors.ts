import { ethers } from "hardhat";
import { loadContracts, DeployedResources } from "../utils/deploy";

import { ReflectiveURIDescriptor } from "../../typechain";

export async function setDescriptors(resources: DeployedResources): Promise<void> {
    const signers = await ethers.getSigners();
    const [deployer] = signers;
    const admin = deployer;

    const BASE_URI = "https://api.arcade.xyz/api/v2/collections/";

    // Get both note contracts
    const { borrowerNote, lenderNote } = resources;

    // Deploy a new descriptor
    const descriptorFactory = await ethers.getContractFactory("ReflectiveURIDescriptor");
    const descriptor = <ReflectiveURIDescriptor>await descriptorFactory.deploy(BASE_URI);
    await descriptor.deployed();

    console.log("ReflectiveURIDescriptor deployed to:", descriptor.address);

    // Update notes
    // let tx = await borrowerNote.connect(admin).setDescriptor(descriptor.address);
    // await tx.wait();

    // tx = await lenderNote.connect(admin).setDescriptor(descriptor.address);
    // await tx.wait();

    console.log("✅ Upgraded descriptor contracts.");
    console.log("\nPaste into deployments JSON:");
    console.log(
        JSON.stringify(
            {
                ReflectiveURIDescriptor: {
                    contractAddress: descriptor.address,
                    constructorArgs: BASE_URI,
                }
            },
            null,
            4,
        ),
    );
    console.log("\n");
}

if (require.main === module) {
    // retrieve command line args array
    const file = process.env.DEPLOYMENT_FILE;

    console.log("File:", file);

    // assemble args to access the relevant deplyment json in .deployment
    void loadContracts(file!)
        .then(setDescriptors)
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
