import { Contract, BigNumberish } from "ethers";
import fetch from "node-fetch";
import { chunk } from "lodash";

import { OriginationController } from "../../typechain";
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

export async function whitelistPayableCurrencies(originationController: OriginationController): Promise<void> {
    type AllowData = { isAllowed: true, minPrincipal: BigNumberish }[]
    const allowData = minPrincipals.reduce(
        (acc: AllowData, minPrincipal) => {
            acc.push({ isAllowed: true, minPrincipal });
            return acc;
        },
    []);

    await originationController.setAllowedPayableCurrencies(
        allowedCurrencies,
        allowData
    );

    console.log(`Whitelisted ${allowedCurrencies.length} payable currencies.`);
}

async function whitelistCollections(originationController: OriginationController): Promise<void> {
    const data = await getVerifiedTokenData();
    const ids = data.reduce((acc: string[], collection) => {
        if (collection.isVerified) acc.push(collection.id);
        return acc;
    }, []);

    const chunkedIds = chunk(ids, 50);

    for (const chunk of chunkedIds) {
        await originationController.setAllowedCollateralAddresses(
            chunk,
            Array(chunk.length).fill(true)
        );
    }

    console.log(`Whitelisted ${ids.length} collections in ${chunkedIds.length} transactions.`);
}

async function whitelistVerifiers(originationController: OriginationController, verifiers: Contract[]): Promise<void> {
    const addrs = verifiers.map((verifier) => verifier.address);

    await originationController.setAllowedVerifiers(
        addrs,
        Array(addrs.length).fill(true)
    );

    console.log(`Whitelisted ${addrs.length} verifiers.`);
}

export async function doWhitelisting(contracts: DeployedResources): Promise<void> {
    // Whitelist payable currencies
    // Whitelist allowed collateral
    // Whitelist verifiers

    const { originationController, arcadeItemsVerifier, collectionWideOfferVerifier, artBlocksVerifier } = contracts;
    await whitelistPayableCurrencies(originationController);
    await whitelistCollections(originationController);
    await whitelistVerifiers(originationController, [arcadeItemsVerifier, collectionWideOfferVerifier, artBlocksVerifier]);

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

