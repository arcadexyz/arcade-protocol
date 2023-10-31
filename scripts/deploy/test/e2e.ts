import { execSync } from "child_process";
import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import assert from "assert";

import {
    NETWORK,
    getLatestDeploymentFile,
    getLatestDeployment,
    getVerifiedABI
} from "./utils";

import { getVerifiedTokenData } from "../whitelisting";

import {
    ORIGINATOR_ROLE,
    ADMIN_ROLE,
    FEE_CLAIMER_ROLE,
    REPAYER_ROLE,
    AFFILIATE_MANAGER_ROLE,
    WHITELIST_MANAGER_ROLE,
    ADMIN,
    VAULT_FACTORY_BASE_URI,
    BORROWER_NOTE_BASE_URI,
    LENDER_NOTE_BASE_URI,
    CALL_WHITELIST_MANAGER,
    RESOURCE_MANAGER,
    LOAN_WHITELIST_MANAGER,
    FEE_CLAIMER,
    RESOURCE_MANAGER_ROLE,
    AFFILIATE_MANAGER,
    allowedCurrencies,
    SHUTDOWN_ROLE,
    SHUTDOWN_CALLER
} from "../../utils/constants";

import {
    CallWhitelistAllExtensions,
    FeeController,
    LoanCore,
    PromissoryNote,
    OriginationController,
    VaultFactory,
    StaticURIDescriptor
} from "../../../typechain";

/**
 * Note: Against normal conventions, these tests are interdependent and meant
 * to run sequentially. Each subsequent test relies on the state of the previous.
 */
assert(NETWORK !== "hardhat", "Must use a long-lived network!");

describe("Deployment", function () {
    this.timeout(0);
    this.bail();

    it("deploys the contracts and creates the correct artifacts", async () => {
        if (process.env.EXEC) {
            // Deploy everything, via command-line
            console.log(); // whitespace
            execSync(`npx hardhat --network ${NETWORK} run scripts/deploy/deploy.ts`, { stdio: 'inherit' });
        }

        // Make sure JSON file exists
        const deployment = getLatestDeployment();

        // Make sure deployment artifacts has all the correct contracts specified
        expect(deployment["CallWhitelistAllExtensions"]).to.exist;
        expect(deployment["CallWhitelistAllExtensions"].contractAddress).to.exist;
        expect(deployment["CallWhitelistAllExtensions"].constructorArgs.length).to.eq(1);

        expect(deployment["AssetVault"]).to.exist;
        expect(deployment["AssetVault"].contractAddress).to.exist;
        expect(deployment["AssetVault"].constructorArgs.length).to.eq(0);

        expect(deployment["VaultFactoryURIDescriptor"]).to.exist;
        expect(deployment["VaultFactoryURIDescriptor"].contractAddress).to.exist;
        expect(deployment["VaultFactoryURIDescriptor"].constructorArgs.length).to.eq(1);
        expect(deployment["VaultFactoryURIDescriptor"].constructorArgs[0]).to.eq(VAULT_FACTORY_BASE_URI);

        expect(deployment["FeeController"]).to.exist;
        expect(deployment["FeeController"].contractAddress).to.exist;
        expect(deployment["FeeController"].constructorArgs.length).to.eq(0);

        expect(deployment["VaultFactory"]).to.exist;
        expect(deployment["VaultFactory"].contractAddress).to.exist;
        expect(deployment["VaultFactory"].constructorArgs.length).to.eq(4);
        expect(deployment["VaultFactory"].constructorArgs[0]).to.eq(deployment["AssetVault"].contractAddress);
        expect(deployment["VaultFactory"].constructorArgs[1]).to.eq(deployment["CallWhitelistAllExtensions"].contractAddress);
        expect(deployment["VaultFactory"].constructorArgs[2]).to.eq(deployment["FeeController"].contractAddress);
        expect(deployment["VaultFactory"].constructorArgs[3]).to.eq(deployment["VaultFactoryURIDescriptor"].contractAddress);

        expect(deployment["BorrowerNoteURIDescriptor"]).to.exist;
        expect(deployment["BorrowerNoteURIDescriptor"].contractAddress).to.exist;
        expect(deployment["BorrowerNoteURIDescriptor"].constructorArgs.length).to.eq(1);
        expect(deployment["BorrowerNoteURIDescriptor"].constructorArgs[0]).to.eq(BORROWER_NOTE_BASE_URI);

        expect(deployment["BorrowerNote"]).to.exist;
        expect(deployment["BorrowerNote"].contractAddress).to.exist;
        expect(deployment["BorrowerNote"].constructorArgs.length).to.eq(3);
        expect(deployment["BorrowerNote"].constructorArgs[0]).to.eq("Arcade.xyz Borrower Note");
        expect(deployment["BorrowerNote"].constructorArgs[1]).to.eq("aBN");
        expect(deployment["BorrowerNote"].constructorArgs[2]).to.eq(deployment["BorrowerNoteURIDescriptor"].contractAddress);

        expect(deployment["LenderNoteURIDescriptor"]).to.exist;
        expect(deployment["LenderNoteURIDescriptor"].contractAddress).to.exist;
        expect(deployment["LenderNoteURIDescriptor"].constructorArgs.length).to.eq(1);
        expect(deployment["LenderNoteURIDescriptor"].constructorArgs[0]).to.eq(LENDER_NOTE_BASE_URI);

        expect(deployment["LenderNote"]).to.exist;
        expect(deployment["LenderNote"].contractAddress).to.exist;
        expect(deployment["LenderNote"].constructorArgs.length).to.eq(3);
        expect(deployment["LenderNote"].constructorArgs[0]).to.eq("Arcade.xyz Lender Note");
        expect(deployment["LenderNote"].constructorArgs[1]).to.eq("aLN");
        expect(deployment["LenderNote"].constructorArgs[2]).to.eq(deployment["LenderNoteURIDescriptor"].contractAddress);

        expect(deployment["LoanCore"]).to.exist;
        expect(deployment["LoanCore"].contractAddress).to.exist;
        expect(deployment["LoanCore"].constructorArgs.length).to.eq(2);
        expect(deployment["LoanCore"].constructorArgs[0]).to.eq(deployment["BorrowerNote"].contractAddress);
        expect(deployment["LoanCore"].constructorArgs[1]).to.eq(deployment["LenderNote"].contractAddress);

        expect(deployment["RepaymentController"]).to.exist;
        expect(deployment["RepaymentController"].contractAddress).to.exist;
        expect(deployment["RepaymentController"].constructorArgs.length).to.eq(2);
        expect(deployment["RepaymentController"].constructorArgs[0]).to.eq(deployment["LoanCore"].contractAddress);
        expect(deployment["RepaymentController"].constructorArgs[1]).to.eq(deployment["FeeController"].contractAddress);

        expect(deployment["OriginationController"]).to.exist;
        expect(deployment["OriginationController"].contractAddress).to.exist;
        expect(deployment["OriginationController"].constructorArgs.length).to.eq(2);
        expect(deployment["OriginationController"].constructorArgs[0]).to.eq(deployment["LoanCore"].contractAddress);
        expect(deployment["OriginationController"].constructorArgs[1]).to.eq(deployment["FeeController"].contractAddress);

        expect(deployment["ArcadeItemsVerifier"]).to.exist;
        expect(deployment["ArcadeItemsVerifier"].contractAddress).to.exist;
        expect(deployment["ArcadeItemsVerifier"].constructorArgs.length).to.eq(0);

        expect(deployment["CollectionWideOfferVerifier"]).to.exist;
        expect(deployment["CollectionWideOfferVerifier"].contractAddress).to.exist;
        expect(deployment["CollectionWideOfferVerifier"].constructorArgs.length).to.eq(0);

        expect(deployment["ArtBlocksVerifier"]).to.exist;
        expect(deployment["ArtBlocksVerifier"].contractAddress).to.exist;
        expect(deployment["ArtBlocksVerifier"].constructorArgs.length).to.eq(0);
    });

    it("correctly sets up initial whitelist state", async () => {
        const filename = getLatestDeploymentFile();
        const deployment = getLatestDeployment();

        if (!ADMIN) {
            throw new Error("did not get admin address!");
        } else {
            console.log("Admin:", ADMIN);
        }

        if (process.env.EXEC) {
            // Run setup, via command-line
            console.log(); // whitespace
            execSync(
                `DEPLOYMENT_FILE=${filename} npx hardhat run scripts/deploy/whitelisting.ts --network ${NETWORK}`,
                { stdio: "inherit" },
            );
        }

        // Check whitelist status
        const originationController = <OriginationController>await ethers.getContractAt(
            "OriginationController",
            deployment["OriginationController"].contractAddress,
        );

        for (const addr of allowedCurrencies) {
            expect(await originationController.isAllowedCurrency(addr)).to.be.true;
        }

        const tokenData = await getVerifiedTokenData();
        const allowedCollateral = tokenData.reduce((acc: string[], collection) => {
            if (collection.isVerified) acc.push(collection.id);
            return acc;
        }, []);

        for (const addr of allowedCollateral) {
            expect(await originationController.isAllowedCollateral(addr)).to.be.true;
        }

        expect(await originationController.isAllowedVerifier(deployment["ArcadeItemsVerifier"].contractAddress)).to.be.true;
        expect(await originationController.isAllowedVerifier(deployment["CollectionWideOfferVerifier"].contractAddress)).to.be.true;
        expect(await originationController.isAllowedVerifier(deployment["ArtBlocksVerifier"].contractAddress)).to.be.true;
    });

    it.only("correctly sets up all roles and permissions", async () => {
        const filename = getLatestDeploymentFile();
        const deployment = getLatestDeployment();
        const [deployer] = await ethers.getSigners();

        console.log("FILENAME", filename);

        if (!ADMIN) {
            throw new Error("did not get admin address!");
        } else {
            console.log("Admin:", ADMIN);
        }

        if (process.env.EXEC) {
            // Run setup, via command-line
            console.log(); // whitespace
            execSync(
                `DEPLOYMENT_FILE=${filename} npx hardhat run scripts/deploy/setup-roles.ts --network ${NETWORK}`,
                { stdio: "inherit" },
            );
        }

        // Check role setup contract by contract
        const cwFactory = await ethers.getContractFactory("CallWhitelistAllExtensions");
        const whitelist = <CallWhitelistAllExtensions>await cwFactory.attach(deployment["CallWhitelistAllExtensions"].contractAddress);

        expect(await whitelist.hasRole(ADMIN_ROLE, ADMIN)).to.be.true;
        expect(await whitelist.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await whitelist.hasRole(WHITELIST_MANAGER_ROLE, CALL_WHITELIST_MANAGER)).to.be.true;
        expect(await whitelist.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);
        expect(await whitelist.getRoleMemberCount(WHITELIST_MANAGER_ROLE)).to.eq(1);

        const StaticURIDescriptorFactory = await ethers.getContractFactory("StaticURIDescriptor");
        const vaultFactoryURIDescriptor = <StaticURIDescriptor>(
            await StaticURIDescriptorFactory.attach(deployment["VaultFactoryURIDescriptor"].contractAddress)
        );

        expect(await vaultFactoryURIDescriptor.owner()).to.eq(RESOURCE_MANAGER);

        const fcFactory = await ethers.getContractFactory("FeeController");
        const feeController = <FeeController>await fcFactory.attach(deployment["FeeController"].contractAddress);

        expect(await feeController.owner()).to.eq(ADMIN);

        const vaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
        const vaultFactory = <VaultFactory>await vaultFactoryFactory.attach(deployment["VaultFactory"].contractAddress);

        expect(await vaultFactory.hasRole(ADMIN_ROLE, ADMIN)).to.be.true;
        expect(await vaultFactory.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await vaultFactory.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);

        expect(await vaultFactory.hasRole(FEE_CLAIMER_ROLE, FEE_CLAIMER)).to.be.true;
        expect(await vaultFactory.hasRole(FEE_CLAIMER_ROLE, deployer.address)).to.be.false;
        expect(await vaultFactory.getRoleMemberCount(FEE_CLAIMER_ROLE)).to.eq(1);

        expect(await vaultFactory.hasRole(RESOURCE_MANAGER_ROLE, RESOURCE_MANAGER)).to.be.true;
        expect(await vaultFactory.hasRole(RESOURCE_MANAGER_ROLE, deployer.address)).to.be.false;
        expect(await vaultFactory.getRoleMemberCount(RESOURCE_MANAGER_ROLE)).to.eq(1);

        const noteFactory = await ethers.getContractFactory("PromissoryNote");

        const borrowerNoteURIDescriptor = <StaticURIDescriptor>(
            await StaticURIDescriptorFactory.attach(deployment["BorrowerNoteURIDescriptor"].contractAddress)
        );

        expect(await borrowerNoteURIDescriptor.owner()).to.eq(RESOURCE_MANAGER);

        const borrowerNote = <PromissoryNote>await noteFactory.attach(deployment["BorrowerNote"].contractAddress);
        expect(await borrowerNote.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await borrowerNote.hasRole(ADMIN_ROLE, ADMIN)).to.be.false;
        expect(await borrowerNote.getRoleMemberCount(ADMIN_ROLE)).to.eq(0);

        const lenderNoteURIDescriptor = <StaticURIDescriptor>(
            await StaticURIDescriptorFactory.attach(deployment["LenderNoteURIDescriptor"].contractAddress)
        );

        expect(await lenderNoteURIDescriptor.owner()).to.eq(RESOURCE_MANAGER);

        const lenderNote = <PromissoryNote>await noteFactory.attach(deployment["LenderNote"].contractAddress);
        expect(await lenderNote.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await lenderNote.hasRole(ADMIN_ROLE, ADMIN)).to.be.false;
        expect(await lenderNote.getRoleMemberCount(ADMIN_ROLE)).to.eq(0);


        const loanCoreFactory = await ethers.getContractFactory("LoanCore");
        const loanCore = <LoanCore>await loanCoreFactory.attach(deployment["LoanCore"].contractAddress);

        expect(await loanCore.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(ADMIN_ROLE, ADMIN)).to.be.true;
        expect(await loanCore.hasRole(ADMIN_ROLE, deployment["OriginationController"].contractAddress)).to.be.false;
        expect(await loanCore.hasRole(ADMIN_ROLE, deployment["RepaymentController"].contractAddress)).to.be.false;
        expect(await loanCore.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);

        expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, FEE_CLAIMER)).to.be.true;
        expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, deployment["OriginationController"].contractAddress)).to.be
            .false;
        expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, deployment["RepaymentController"].contractAddress)).to.be.false;
        expect(await loanCore.getRoleMemberCount(FEE_CLAIMER_ROLE)).to.eq(1);

        expect(await loanCore.hasRole(ORIGINATOR_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(ORIGINATOR_ROLE, ADMIN)).to.be.false;
        expect(await loanCore.hasRole(ORIGINATOR_ROLE, deployment["OriginationController"].contractAddress)).to.be.true;
        expect(await loanCore.hasRole(ORIGINATOR_ROLE, deployment["RepaymentController"].contractAddress)).to.be.false;
        expect(await loanCore.getRoleMemberCount(ORIGINATOR_ROLE)).to.eq(1);

        expect(await loanCore.hasRole(REPAYER_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(REPAYER_ROLE, ADMIN)).to.be.false;
        expect(await loanCore.hasRole(REPAYER_ROLE, deployment["OriginationController"].contractAddress)).to.be.false;
        expect(await loanCore.hasRole(REPAYER_ROLE, deployment["RepaymentController"].contractAddress)).to.be.true;
        expect(await loanCore.getRoleMemberCount(REPAYER_ROLE)).to.eq(1);

        expect(await loanCore.hasRole(AFFILIATE_MANAGER_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(AFFILIATE_MANAGER_ROLE, AFFILIATE_MANAGER)).to.be.true;
        expect(await loanCore.hasRole(AFFILIATE_MANAGER_ROLE, deployment["OriginationController"].contractAddress)).to
            .be.false;
        expect(await loanCore.hasRole(AFFILIATE_MANAGER_ROLE, deployment["RepaymentController"].contractAddress)).to.be
            .false;
        expect(await loanCore.getRoleMemberCount(AFFILIATE_MANAGER_ROLE)).to.eq(1);

        expect(await loanCore.hasRole(SHUTDOWN_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(SHUTDOWN_ROLE, SHUTDOWN_CALLER)).to.be.true;
        expect(await loanCore.hasRole(SHUTDOWN_ROLE, deployment["OriginationController"].contractAddress)).to
            .be.false;
        expect(await loanCore.hasRole(SHUTDOWN_ROLE, deployment["RepaymentController"].contractAddress)).to.be
            .false;
        expect(await loanCore.getRoleMemberCount(SHUTDOWN_ROLE)).to.eq(1);

        const ocFactory = await ethers.getContractFactory("OriginationController");
        const originationController = <OriginationController>(
            await ocFactory.attach(deployment["OriginationController"].contractAddress)
        );

        expect(await originationController.hasRole(ADMIN_ROLE, ADMIN)).to.be.true;
        expect(await originationController.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await originationController.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);

        expect(await originationController.hasRole(WHITELIST_MANAGER_ROLE, LOAN_WHITELIST_MANAGER)).to.be.true;
        expect(await originationController.hasRole(WHITELIST_MANAGER_ROLE, deployer.address)).to.be.false;
        expect(await originationController.getRoleMemberCount(WHITELIST_MANAGER_ROLE)).to.eq(1);
    });

    it.skip("verifies all contracts on the proper network", async () => {
        const filename = getLatestDeploymentFile();
        const deployment = getLatestDeployment();

        if (process.env.EXEC) {
            // Run setup, via command-line
            console.log(); // whitespace
            execSync(
                `DEPLOYMENT_FILE=${filename} npx hardhat run scripts/deploy/verify-contracts.ts --network ${NETWORK}`,
                { stdio: "inherit" },
            );
        }

        // For each contract - compare verified ABI against artifact ABI
        for (let contractName of Object.keys(deployment)) {
            const contractData = deployment[contractName];

            if (contractName.endsWith("Note")) contractName = "PromissoryNote";
            else if (contractName.endsWith("Descriptor")) contractName = "StaticURIDescriptor";
            const artifact = await artifacts.readArtifact(contractName);

            const verifiedAbi = await getVerifiedABI(contractData.contractAddress);
            expect(artifact.abi).to.deep.equal(verifiedAbi);
        }
    });

});