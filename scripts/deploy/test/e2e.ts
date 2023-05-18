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

import {
    ORIGINATOR_ROLE,
    ADMIN_ROLE,
    FEE_CLAIMER_ROLE,
    REPAYER_ROLE,
    BASE_URI,
    AFFILIATE_MANAGER_ROLE,
    WHITELIST_MANAGER_ROLE,
} from "../../utils/constants";

import {
    CallWhitelist,
    FeeController,
    LoanCore,
    PromissoryNote,
    OriginationController,
    VaultFactory,
    BaseURIDescriptor
} from "../../../typechain";

/**
 * Note: Against normal conventions, these tests are interdependent and meant
 * to run sequentially. Each subsequent test relies on the state of the previous.
 */
assert(NETWORK !== "hardhat", "Must use a long-lived network!");

describe("Deployment", function() {
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
        expect(deployment["CallWhitelist"]).to.exist;
        expect(deployment["CallWhitelist"].contractAddress).to.exist;
        expect(deployment["CallWhitelist"].constructorArgs.length).to.eq(0);

        expect(deployment["BaseURIDescriptor"]).to.exist;
        expect(deployment["BaseURIDescriptor"].contractAddress).to.exist;
        expect(deployment["BaseURIDescriptor"].constructorArgs.length).to.eq(1);
        expect(deployment["BaseURIDescriptor"].constructorArgs[0]).to.eq(`${BASE_URI}`);

        expect(deployment["FeeController"]).to.exist;
        expect(deployment["FeeController"].contractAddress).to.exist;
        expect(deployment["FeeController"].constructorArgs.length).to.eq(0);

        expect(deployment["AssetVault"]).to.exist;
        expect(deployment["AssetVault"].contractAddress).to.exist;
        expect(deployment["AssetVault"].constructorArgs.length).to.eq(0);

        expect(deployment["VaultFactory"]).to.exist;
        expect(deployment["VaultFactory"].contractAddress).to.exist;
        expect(deployment["VaultFactory"].constructorArgs.length).to.eq(4);
        expect(deployment["VaultFactory"].constructorArgs[0]).to.eq(deployment["AssetVault"].contractAddress);
        expect(deployment["VaultFactory"].constructorArgs[1]).to.eq(deployment["CallWhitelist"].contractAddress);
        expect(deployment["VaultFactory"].constructorArgs[2]).to.eq(deployment["FeeController"].contractAddress);
        expect(deployment["VaultFactory"].constructorArgs[3]).to.eq(deployment["BaseURIDescriptor"].contractAddress);

        expect(deployment["BorrowerNote"]).to.exist;
        expect(deployment["BorrowerNote"].contractAddress).to.exist;
        expect(deployment["BorrowerNote"].constructorArgs.length).to.eq(3);
        expect(deployment["BorrowerNote"].constructorArgs[0]).to.eq("Arcade.xyz BorrowerNote");
        expect(deployment["BorrowerNote"].constructorArgs[1]).to.eq("aBN");
        expect(deployment["BorrowerNote"].constructorArgs[2]).to.eq(deployment["BaseURIDescriptor"].contractAddress);

        expect(deployment["LenderNote"]).to.exist;
        expect(deployment["LenderNote"].contractAddress).to.exist;
        expect(deployment["LenderNote"].constructorArgs.length).to.eq(3);
        expect(deployment["LenderNote"].constructorArgs[0]).to.eq("Arcade.xyz LenderNote");
        expect(deployment["LenderNote"].constructorArgs[1]).to.eq("aLN");
        expect(deployment["LenderNote"].constructorArgs[2]).to.eq(deployment["BaseURIDescriptor"].contractAddress);

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
    });

    it("correctly sets up all roles and permissions", async () => {
        const filename = getLatestDeploymentFile();
        const deployment = getLatestDeployment();
        const [deployer] = await ethers.getSigners();
        const ADMIN_ADDRESS = process.env.ADMIN;
        //const ADMIN_ADDRESS = "0xAdD93e738a415c5248f7cB044FCFC71d86b18572";

        if (!ADMIN_ADDRESS) {
            throw new Error("did not get admin address!");
        } else {
            console.log("Admin:", ADMIN_ADDRESS);
        }

        if (process.env.EXEC) {
            // Run setup, via command-line
            console.log(); // whitespace
            execSync(`HARDHAT_NETWORK=${NETWORK} ADMIN=${ADMIN_ADDRESS} ts-node scripts/deploy/setup-roles.ts ${filename}`, { stdio: 'inherit' });
        }

        // Check role setup contract by contract
        const cwFactory = await ethers.getContractFactory("CallWhitelist");
        const whitelist = <CallWhitelist>await cwFactory.attach(deployment["CallWhitelist"].contractAddress);

        expect(await whitelist.owner()).to.eq(ADMIN_ADDRESS);

        const baseURIDescriptorFactory = await ethers.getContractFactory("BaseURIDescriptor");
        const baseURIDescriptor = <BaseURIDescriptor>(
            await baseURIDescriptorFactory.attach(deployment["BaseURIDescriptor"].contractAddress)
        );

        expect(await baseURIDescriptor.owner()).to.eq(ADMIN_ADDRESS);

        const fcFactory = await ethers.getContractFactory("FeeController");
        const feeController = <FeeController>await fcFactory.attach(deployment["FeeController"].contractAddress);

        expect(await feeController.owner()).to.eq(ADMIN_ADDRESS);

        const vaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
        const vaultFactory = <VaultFactory>await vaultFactoryFactory.attach(deployment["VaultFactory"].contractAddress);

        expect(await vaultFactory.hasRole(ADMIN_ROLE, ADMIN_ADDRESS)).to.be.true;
        expect(await vaultFactory.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;

        expect(await vaultFactory.hasRole(FEE_CLAIMER_ROLE, ADMIN_ADDRESS)).to.be.true;
        expect(await vaultFactory.hasRole(FEE_CLAIMER_ROLE, deployer.address)).to.be.false;

        const noteFactory = await ethers.getContractFactory("PromissoryNote");

        const borrowerNote = <PromissoryNote>await noteFactory.attach(deployment["BorrowerNote"].contractAddress);
        expect(await borrowerNote.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await borrowerNote.hasRole(ADMIN_ROLE, ADMIN_ADDRESS)).to.be.false;
        expect(await borrowerNote.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;

        const lenderNote = <PromissoryNote>await noteFactory.attach(deployment["LenderNote"].contractAddress);
        expect(await lenderNote.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await lenderNote.hasRole(ADMIN_ROLE, ADMIN_ADDRESS)).to.be.false;

        expect(await lenderNote.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;

        const loanCoreFactory = await ethers.getContractFactory("LoanCore");
        const loanCore = <LoanCore>await loanCoreFactory.attach(deployment["LoanCore"].contractAddress);

        expect(await loanCore.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(ADMIN_ROLE, ADMIN_ADDRESS)).to.be.true;
        expect(await loanCore.hasRole(ADMIN_ROLE, deployment["OriginationController"].contractAddress)).to.be.false;
        expect(await loanCore.hasRole(ADMIN_ROLE, deployment["RepaymentController"].contractAddress)).to.be.false;
        expect(await loanCore.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);

        expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, ADMIN_ADDRESS)).to.be.true;
        expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, deployment["OriginationController"].contractAddress)).to.be.false;
        expect(await loanCore.hasRole(FEE_CLAIMER_ROLE, deployment["RepaymentController"].contractAddress)).to.be.false;
        expect(await loanCore.getRoleMemberCount(FEE_CLAIMER_ROLE)).to.eq(1);

        expect(await loanCore.hasRole(ORIGINATOR_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(ORIGINATOR_ROLE, ADMIN_ADDRESS)).to.be.false;
        expect(await loanCore.hasRole(ORIGINATOR_ROLE, deployment["OriginationController"].contractAddress)).to.be.true;
        expect(await loanCore.hasRole(ORIGINATOR_ROLE, deployment["RepaymentController"].contractAddress)).to.be.false;
        expect(await loanCore.getRoleMemberCount(ORIGINATOR_ROLE)).to.eq(1);

        expect(await loanCore.hasRole(REPAYER_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(REPAYER_ROLE, ADMIN_ADDRESS)).to.be.false;
        expect(await loanCore.hasRole(REPAYER_ROLE, deployment["OriginationController"].contractAddress)).to.be.false;
        expect(await loanCore.hasRole(REPAYER_ROLE, deployment["RepaymentController"].contractAddress)).to.be.true;
        expect(await loanCore.getRoleMemberCount(REPAYER_ROLE)).to.eq(1);

        expect(await loanCore.hasRole(AFFILIATE_MANAGER_ROLE, deployer.address)).to.be.false;
        expect(await loanCore.hasRole(AFFILIATE_MANAGER_ROLE, ADMIN_ADDRESS)).to.be.false;
        expect(await loanCore.hasRole(AFFILIATE_MANAGER_ROLE, deployment["OriginationController"].contractAddress)).to
            .be.false;
        expect(await loanCore.hasRole(AFFILIATE_MANAGER_ROLE, deployment["RepaymentController"].contractAddress)).to.be
            .false;

        const ocFactory = await ethers.getContractFactory("OriginationController");
        const originationController = <OriginationController>await ocFactory.attach(deployment["OriginationController"].contractAddress);

        expect(await originationController.hasRole(ADMIN_ROLE, ADMIN_ADDRESS)).to.be.true;
        expect(await originationController.hasRole(ADMIN_ROLE, deployer.address)).to.be.false;
        expect(await originationController.getRoleMemberCount(ADMIN_ROLE)).to.eq(1);

        expect(await originationController.hasRole(WHITELIST_MANAGER_ROLE, ADMIN_ADDRESS)).to.be.true;
        // The expect statement will work after the deployer renounces the role post finishing the token whitelisting
        //expect(await originationController.hasRole(WHITELIST_MANAGER_ROLE, deployer.address)).to.be.false;
        expect(await originationController.getRoleMemberCount(WHITELIST_MANAGER_ROLE)).to.eq(1);
    });

    it("verifies all contracts on the proper network", async () => {
        const filename = getLatestDeploymentFile();
        const deployment = getLatestDeployment();

        if (process.env.EXEC) {
            // Run setup, via command-line
            console.log(); // whitespace
            execSync(`HARDHAT_NETWORK=${NETWORK} ts-node scripts/deploy/verify-contracts.ts ${filename}`, { stdio: 'inherit' });
        }

        // For each contract - compare verified ABI against artifact ABI
        for (let contractName of Object.keys(deployment)) {
            const contractData = deployment[contractName];

            if (contractName.includes("Note")) contractName = "PromissoryNote";
            const artifact = await artifacts.readArtifact(contractName);

            const verifiedAbi = await getVerifiedABI(contractData.contractAddress);
            expect(artifact.abi).to.deep.equal(verifiedAbi);
        }
    });

    it.skip("can run sample loans")
});