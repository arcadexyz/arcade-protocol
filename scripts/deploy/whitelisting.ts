import { Contract, BigNumberish } from "ethers";

import { OriginationController } from "../../typechain";
import { loadContracts, DeployedResources } from "../utils/deploy";
import { allowedCurrencies, minPrincipals } from "../utils/constants";

export async function whitelistPayableCurrencies(originationController: OriginationController): Promise<void> {
    type AllowData = { isAllowed: true; minPrincipal: BigNumberish }[];

    const allowData = minPrincipals.reduce((acc: AllowData, minPrincipal) => {
        acc.push({ isAllowed: true, minPrincipal });
        return acc;
    }, []);

    const tx = await originationController.setAllowedPayableCurrencies(allowedCurrencies, allowData);
    await tx.wait();

    console.log(`Whitelisted ${allowedCurrencies.length} payable currencies.`);
}

async function whitelistCollections(
    originationController: OriginationController,
    vaultFactory: Contract,
): Promise<void> {
    const addresses: string[] = [
        "0xA449b4f43D9A33FcdCF397b9cC7Aa909012709fD", // Onchain Gaias
        "0xBa5e05cb26b78eDa3A2f8e3b3814726305dcAc83", // Base Paint
        "0x13dc8261FCe63499Aa25DEB512bb1827B411b83B", // Swatches
        "0x2D53D0545CD1275B69040e3C50587E2CC4443A52", // Base Gods
        "0x217Ec1aC929a17481446A76Ff9B95B9a64F298cF", // Based Fellas
        "0x473Fa8223F2E849781778C3b2b144a7cc0742Bf8", // Stained Glass
        "0xcB28749c24AF4797808364D71d71539bc01E76d4", // based punks
        "0x949bED087Ff0241E04E98D807DE3C3Dd97EAa381", // Mochimons
        "0x0c9249D3ebfb491C4053E98e1FF777Fe44CF1581", // Normilady
        "0xe223dF3cF0953048eb3c575abcD81818C9ea74B8", // Everywhere You See
        "0x7756a5315346ba448698D3d593238AC4e0E9fCdB", // Syntropy
        "0x20479B19Ca05e0b63875a65ACf24d81cd0973331", // swatches x prohibition
        "0x6402dbE605260981fe7aF259EC7a51FA74848AF4", // Prohibited Bunny
        "0xFe1857CBd3D01849D01561DdB1Cf3CdBa93A5781", // My Red Period
        "0xB005eb1a7d873a1949a660e186A371970F052907", // Every Thought Is Taken By You
        "0x4B3C292592b9d2FEDa6817DB21ab99Bbec5ceb37", // Transitions
        "0x28C2D938C7aFAbb9D83cF0D52d936236ED17FE7b", // prohibuild
        "0xcEAd19855115531F0c19789cc783dD0c96666be6", // A Destiny Delayed
        "0xeCa5F63E4C281516444825359bF04cAC5a915880", // pixel blobs
        "0x09ABBfC872A726739F013C4D6AF656dD2d49e3D5", // Search
        "0xf42cFC0521aeD33D7795a5152d487e8dD446E4F0", // Ascension
        "0x074aC088b2cF8d39141BE090DA7d91d49138628A", // dubs
        "0x902e4A04583555a6F20e7Fa0a0D6470D05388Fcb", // Travor Traynor - aXis
        "0x708A6a44f56f47548c0bff16c9fe18aBa9F5338B", // God told me to
        "0xf0d0dF7142f60F7F3847463A509fD8969E3e3A27", // tiny based frogs
        "0x143b66ebeC3417554c1BBB582069e6d9f4c69e23", // Watch-baked NFTs by Watches.io
        "0x726d09eb63B6FEB1B6e9cD19b3Add4Bbee749a74", // Neo Squiggles
        "0x617978b8af11570c2dAb7c39163A8bdE1D282407", // Based Bits
        "0xB398284a3C9Bed26B5FF28f620A3d04dBDEC2c80", // Algorithm
    ];

    const tx = await originationController.setAllowedCollateralAddresses(addresses, Array(addresses.length).fill(true));
    await tx.wait();

    console.log(`Whitelisted ${addresses.length} collections.`);

    const tx1 = await originationController.setAllowedCollateralAddresses([vaultFactory.address], [true]);
    await tx1.wait();

    console.log(`Whitelisted VaultFactory at ${vaultFactory.address}.}`);
}

async function whitelistVerifiers(originationController: OriginationController, verifiers: Contract[]): Promise<void> {
    const addrs = verifiers.map(verifier => verifier.address);

    await originationController.setAllowedVerifiers(addrs, Array(addrs.length).fill(true));

    console.log(`Whitelisted ${addrs.length} verifiers.`);
}

export async function doWhitelisting(contracts: DeployedResources): Promise<void> {
    // Whitelist payable currencies
    // Whitelist allowed collateral
    // Whitelist verifiers

    const {
        originationController,
        arcadeItemsVerifier,
        collectionWideOfferVerifier,
        vaultFactory
    } = contracts;

    await whitelistPayableCurrencies(originationController);
    await whitelistCollections(originationController, vaultFactory);
    await whitelistVerifiers(originationController, [
        arcadeItemsVerifier,
        collectionWideOfferVerifier,
    ]);

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
        .then(doWhitelisting)
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
