import { ethers } from "hardhat";

import { loadContracts, DeployedResources } from "./utils/deploy";

export async function addToWhitelist(contracts: DeployedResources): Promise<void> {
    // Whitelist payable currencies
    // Whitelist allowed collateral
    // Whitelist verifiers

    const { originationController } = contracts;
    const [, admin] = await ethers.getSigners();

    const allowedCurrencies = [
        "0x07865c6e87b9f70255377e024ace6630c1eaa37f",
        "0x11fe4b6ae13d2a6055c8d9cf65c55bac32b5d844",
        "0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6"
    ];

    const allowData = [
        { isAllowed: true, minPrincipal: ethers.utils.parseUnits("1", 6) },
        { isAllowed: true, minPrincipal: ethers.utils.parseEther("0.001") },
        { isAllowed: true, minPrincipal: ethers.utils.parseEther("0.001") }
    ]

    await originationController.connect(admin).setAllowedPayableCurrencies(
        allowedCurrencies,
        allowData
    );

    console.log(`Whitelisted ${allowedCurrencies.length} payable currencies.`);

    const newCollections = [
        "0xf5de760f2e916647fd766b4ad9e85ff943ce3a2b",
        "0xf40299b626ef6e197f5d9de9315076cab788b6ef",
        "0x3f228cbcec3ad130c45d21664f2c7f5b23130d23",
        "0xd60d682764ee04e54707bee7b564dc65b31884d0",
        "0xf5de760f2e916647fd766b4ad9e85ff943ce3a2b"
    ];

    await originationController.connect(admin).setAllowedCollateralAddresses(
        newCollections,
        Array(newCollections.length).fill(true)
    );

    console.log("✅ Whitelisting complete.");
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    // retrieve command line args array
    const file = process.env.DEPLOYMENT_FILE;

    console.log("File:", file);

    // assemble args to access the relevant deplyment json in .deployment
    void loadContracts(file!)
        .then(addToWhitelist)
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}

