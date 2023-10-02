import { ethers } from "hardhat";
import { loadContracts, DeployedResources } from "../utils/deploy";

import { ReflectiveURIDescriptor } from "../../typechain";

export async function setDescriptors(resources: DeployedResources): Promise<void> {
    const signers = await ethers.getSigners();
    const [deployer] = signers;
    const admin = deployer;

    // Get both note contracts
    const { borrowerNote, lenderNote } = resources;

    // Deploy a new descriptor
    const descriptorFactory = await ethers.getContractFactory("ReflectiveURIDescriptor");
    const descriptor = <ReflectiveURIDescriptor>await descriptorFactory.deploy("https://api-goerli.arcade.xyz/api/v2/collections/");

    // Update notes
    let tx = await borrowerNote.connect(admin).setDescriptor(descriptor.address);
    await tx.wait();

    tx = await lenderNote.connect(admin).setDescriptor(descriptor.address);

    console.log("✅ Upgraded descriptor contracts.");
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
