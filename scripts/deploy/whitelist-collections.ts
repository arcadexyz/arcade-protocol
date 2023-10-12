import { Contract, BigNumberish } from "ethers";
import { chunk } from "lodash";

import { OriginationController } from "../../typechain";
import { loadContracts, DeployedResources } from "../utils/deploy";


export async function whitelistCollections(contracts: DeployedResources): Promise<void> {
    // Whitelist payable currencies
    // Whitelist allowed collateral
    // Whitelist verifiers

    const {
        originationController
    } = contracts;

    const ids = [
        "0xDa6558fA1c2452938168EF79DfD29c45Aba8a32B",
        "0x7d0874F682c42f0Fe907baF7785d9Dcb5a0b1285",
        "0xEAD67175CDb9CBDeA5bDDC36015e52f4A954E3fD",
        "0xa7d679DaeF34A628c9971F5c6b1133e0FAb11207",
        "0xa57D1519F426D5F961B3B37E298f3020a8fae115",
        "0x184ddb67E2EF517f6754F055b56905f2A9b29b6A",
        "0x8C3c0274c33f263F0A55d129cFC8eaa3667A9E8b",
        "0xCdE13b6535f63B328A48EFf2ab049B96794b7dB7",
        "0xAC29AEB4fF322fa3AD08A7b1903B4e1E358c445a",
        "0xb03676314dda4f2887f0F6ff268693968245Dfa0",
        "0x1000a71CB62987142708f8BbC8c5BfbD0316fEb0",
        "0x5830354bADC34ABe0064e80F96cA2c923bd6A2F1",
        "0x18385240632282bb38c2f6f279c9c2735da38cf6",
        "0x8d9710f0e193d3f95c0723eaaf1a81030dc9116d",
        "0x86cc280d0bac0bd4ea38ba7d31e895aa20cceb4b",
        "0xff9c1b15b16263c61d017ee9f65c50e4ae0113d7",
        "0x05745e72fb8b4a9b51118a168d956760e4a36444",
        "0x6161235f0348bcf382390696e34792ecce0c47be",
        "0x7feb477600a03fd6ab1fe451cb3c7836a420f4ad",
        "0x0c56f29B8D90eea71D57CAdEB3216b4Ef7494abC",
        "0xdfde78d2baec499fe18f2be74b6c287eed9511d7",
        "0xd253786537544aa5213dcd084e437160c95db6d8",
        "0x13FB39bA4A9Dee4e9ed044bf45A439d1E2B17660",
        "0x99a9B7c1116f9ceEB1652de04d5969CcE509B069",
    ];

    const calldata = originationController.interface.encodeFunctionData(
        "setAllowedCollateralAddresses",
        [ids, Array(ids.length).fill(true)]
    );

    console.log("Whitelisting calldata:")
    console.log(calldata);

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
        .then(whitelistCollections)
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
