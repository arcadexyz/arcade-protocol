import { Contract, BigNumberish } from "ethers";
import fetch from "node-fetch";
import { chunk } from "lodash";

import { OriginationHelpers } from "../../typechain";
import { loadContracts, DeployedResources } from "../utils/deploy";
import { allowedCurrencies, minPrincipals } from "../utils/constants";

/**
 * Live data for approved collections on Arcade: https://api.arcade.xyz/api/v2/collections/
 * API details: https://docs.arcade.xyz/reference/get_api-v2-collections
 */

export async function getVerifiedTokenData(): Promise<Record<string, any>[]> {
    try {
        const apiURL = `https://api.arcade.xyz/api/v2/collections/?isVerified=true`;
        const resp = await fetch(apiURL, {
            method: "GET",
            headers: {
                "Content-type": "application/json",
                "X-Auth-Token": `${process.env.ARCADE_API_KEY}`,
            },
        });

        const data = await resp.json();
        return data;
    } catch (error) {
        console.error(error);

        return [];
    }
}

export async function whitelistPayableCurrencies(originationHelpers: OriginationHelpers): Promise<void> {
    type AllowData = { isAllowed: true; minPrincipal: BigNumberish }[];

    const allowData = minPrincipals.reduce((acc: AllowData, minPrincipal) => {
        acc.push({ isAllowed: true, minPrincipal });
        return acc;
    }, []);

    const tx = await originationHelpers.setAllowedPayableCurrencies(allowedCurrencies, allowData);
    await tx.wait();

    console.log(`Whitelisted ${allowedCurrencies.length} payable currencies.`);
}

async function whitelistCollections(
    originationHelpers: OriginationHelpers,
    vaultFactory: Contract,
): Promise<void> {
    const data = await getVerifiedTokenData();
    const ids = data.reduce((acc: string[], collection) => {
        if (collection.isVerified) acc.push(collection.id);
        return acc;
    }, []);

    const chunkedIds = chunk(ids, 50);

    for (const chunk of chunkedIds) {
        const tx = await originationHelpers.setAllowedCollateralAddresses(chunk, Array(chunk.length).fill(true));
        await tx.wait();
    }

    console.log(`Whitelisted ${ids.length} collections in ${chunkedIds.length} transactions.`);

    const tx = await originationHelpers.setAllowedCollateralAddresses(
        [
            vaultFactory.address,
            "0x6e9B4c2f6Bd57b7b924d29b5dcfCa1273Ecc94A2", // v2 Vault Factory (General)
            "0x666faa632E5f7bA20a7FCe36596A6736f87133Be", // v2 Vault Factory (Ape Staking)
            "0x7594916540e60fC8d6e9Ba5c3C83632F7001Cf53", // v2 Vault Factory (SuperRare)
            "0x269363665Dbb1582b143099a3cb467E98a476D55", // v3 Vault Factory
        ],
        [true, true, true, true, true],
    );
    await tx.wait();

    console.log(`Whitelisted VaultFactory at ${vaultFactory.address}.}`);
}

async function whitelistVerifiers(originationHelpers: OriginationHelpers, verifiers: Contract[]): Promise<void> {
    const addrs = verifiers.map(verifier => verifier.address);

    await originationHelpers.setAllowedVerifiers(addrs, Array(addrs.length).fill(true));

    console.log(`Whitelisted ${addrs.length} verifiers.`);
}

export async function doWhitelisting(contracts: DeployedResources): Promise<void> {
    // Whitelist payable currencies
    // Whitelist allowed collateral
    // Whitelist verifiers

    const {
        originationHelpers,
        arcadeItemsVerifier,
        collectionWideOfferVerifier,
        artBlocksVerifier,
        vaultFactory
    } = contracts;

    await whitelistPayableCurrencies(originationHelpers);
    await whitelistCollections(originationHelpers, vaultFactory);
    await whitelistVerifiers(originationHelpers, [
        arcadeItemsVerifier,
        collectionWideOfferVerifier,
        artBlocksVerifier,
    ]);

    console.log("✅ Whitelisting complete.");
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    // retrieve command line args array
    const file = process.env.DEPLOYMENT_FILE;

    console.log("File:", file);

    // assemble args to access the relevant deployment json in .deployment
    void loadContracts(file!)
        .then(doWhitelisting)
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
