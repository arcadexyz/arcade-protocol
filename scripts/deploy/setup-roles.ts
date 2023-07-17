import fs from "fs"
import hre, { ethers } from "hardhat";
import { Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

import { SUBSECTION_SEPARATOR, SECTION_SEPARATOR } from "../utils/constants";
import {
    ORIGINATOR_ROLE,
    ADMIN_ROLE,
    FEE_CLAIMER_ROLE,
    REPAYER_ROLE,
    RESOURCE_MANAGER_ROLE,
    WHITELIST_MANAGER_ROLE
} from "../utils/constants";

const jsonContracts: { [key: string]: string } = {
    CallWhitelist: "whitelist",
    BaseURIDescriptor: "baseURIDescriptor",
    FeeController: "feeController",
    AssetVault: "assetVault",
    VaultFactory: "factory",
    BorrowerNote: "borrowerNote",
    LenderNote: "lenderNote",
    LoanCore: "loanCore",
    RepaymentController: "repaymentController",
    OriginationController: "originationController",
    ArcadeItemsVerifier: "verifier",
    PunksVerifier: "punksVerifier",
    CollectionWideOfferVerifier: "collectionWideOfferVerifier",
    ArtBlocksVerifier: "artBlocksVerifier",
    UnvaultedItemsVerifier: "unvaultedItemsVerifier",
    CallWhitelistApprovals: "callWhitelistApprovals",
    CallWhitelistDelegation: "callWhitelistDelegation",
};

type ContractArgs = {
    whitelist: Contract;
    baseURIDescriptor: Contract;
    feeController: Contract;
    assetVault: Contract;
    factory: Contract;
    borrowerNote: Contract;
    lenderNote: Contract;
    loanCore: Contract;
    repaymentController: Contract;
    originationController: Contract;
    verifier: Contract;
    punksVerifier: Contract;
    collectionWideOfferVerifier: Contract;
    artBlocksVerifier: Contract;
    unvaultedItemsVerifer: Contract;
    callWhitelistApprovals: Contract;
    callWhitelistDelegation: Contract;
};

export async function main(
    whitelist: Contract,
    baseURIDescriptor: Contract,
    feeController: Contract,
    assetVault: Contract,
    factory: Contract,
    borrowerNote: Contract,
    lenderNote: Contract,
    loanCore: Contract,
    repaymentController: Contract,
    originationController: Contract,
    verifier: Contract,
    punksVerifier: Contract,
    collectionWideOfferVerifier: Contract,
    artBlocksVerifier: Contract,
    unvaultedItemsVerifier: Contract,
    callWhitelistApprovals: Contract,
    callWhitelistDelegation: Contract,
): Promise<void> {
    const signers: SignerWithAddress[] = await hre.ethers.getSigners();
    const [deployer] = signers;

    // Set admin address
    const ADMIN_ADDRESS = process.env.ADMIN;
    console.log("Admin address:", ADMIN_ADDRESS);

    // Define roles
    const ORIGINATION_CONTROLLER_ADDRESS = originationController.address;
    const LOAN_CORE_ADDRESS = loanCore.address;
    const REPAYMENT_CONTROLLER_ADDRESS = repaymentController.address;

    console.log(SECTION_SEPARATOR);

    // ============= CallWhitelist ==============

    // set CallWhiteList admin
    const updateWhitelistAdmin = await whitelist.transferOwnership(ADMIN_ADDRESS);
    await updateWhitelistAdmin.wait();

    console.log(`CallWhitelist: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= CallWhitelistApprovals ==============

    // set CallWhiteListApprovals admin
    const updateWhitelistApprovalsAdmin = await callWhitelistApprovals.transferOwnership(ADMIN_ADDRESS);
    await updateWhitelistApprovalsAdmin.wait();

    console.log(`CallWhitelistApprovals: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= CallWhitelistDelegation ==============

    // set CallWhiteListDelegation admin
    const updateWhitelistDelegationAdmin = await callWhitelistDelegation.transferOwnership(ADMIN_ADDRESS);
    await updateWhitelistDelegationAdmin.wait();

    console.log(`CallWhitelistDelegation: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== BaseURIDescriptor ============

    // set BaseURIDescriptorAdmin admin
    const updateBaseURIDescriptorAdmin = await baseURIDescriptor.transferOwnership(ADMIN_ADDRESS);
    await updateBaseURIDescriptorAdmin.wait();

    console.log(`BaseURIDescriptor: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= FeeController ==============

    // set FeeController admin
    const updateFeeControllerAdmin = await feeController.transferOwnership(ADMIN_ADDRESS);
    await updateFeeControllerAdmin.wait();

    console.log(`FeeController: ownership transferred to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= BorrowerNote ==============

    const initBorrowerNote = await borrowerNote.initialize(LOAN_CORE_ADDRESS);
    await initBorrowerNote.wait();

    console.log(`BorrowerNote: initialized loanCore at address ${LOAN_CORE_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= LenderNote ==============

    const initLenderNote = await lenderNote.initialize(LOAN_CORE_ADDRESS);
    await initLenderNote.wait();

    console.log(`LenderNote: initialized loanCore at address ${LOAN_CORE_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= LoanCore ==============

    // grant the admin role for LoanCore
    const updateLoanCoreAdmin = await loanCore.grantRole(ADMIN_ROLE, ADMIN_ADDRESS);
    await updateLoanCoreAdmin.wait();

    console.log(`LoanCore: admin role granted to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // grant LoanCore admin fee claimer permissions
    const updateLoanCoreFeeClaimer = await loanCore.grantRole(FEE_CLAIMER_ROLE, ADMIN_ADDRESS);
    await updateLoanCoreFeeClaimer.wait();

    console.log(`LoanCore: fee claimer role granted to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // grant originationContoller the originator role
    const updateOriginationControllerRole = await loanCore.grantRole(ORIGINATOR_ROLE, ORIGINATION_CONTROLLER_ADDRESS);
    await updateOriginationControllerRole.wait();

    console.log(`LoanCore: originator role granted to ${ORIGINATION_CONTROLLER_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // grant repaymentContoller the REPAYER_ROLE
    const updateRepaymentControllerAdmin = await loanCore.grantRole(REPAYER_ROLE, REPAYMENT_CONTROLLER_ADDRESS);
    await updateRepaymentControllerAdmin.wait();

    console.log(`LoanCore: repayer role granted to ${REPAYMENT_CONTROLLER_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // // renounce ownership from deployer
    // const renounceAdmin = await loanCore.renounceRole(ADMIN_ROLE, deployer.address);
    // await renounceAdmin.wait();

    //console.log("LoanCore: deployer has renounced admin role");
    console.log(SUBSECTION_SEPARATOR);

    // ============= OriginationController ==============

    // whitelist verifiers
    const setWhitelistVerifier = await originationController.setAllowedVerifiers([verifier.address], [true]);
    await setWhitelistVerifier.wait();

    console.log(`OriginationController added ArcadeItemsVerifier, at address: ${verifier.address} as allowed verifier`);
    console.log(SUBSECTION_SEPARATOR);

    const setPunksVerifier = await originationController.setAllowedVerifiers([punksVerifier.address], [true]);
    await setPunksVerifier.wait();

    console.log(`OriginationController added PunksVerifier, at address: ${punksVerifier.address} as allowed verifier`);
    console.log(SUBSECTION_SEPARATOR);

    const setcollectionWideOfferVerifier = await originationController.setAllowedVerifiers(
        [collectionWideOfferVerifier.address],
        [true],
    );
    await setcollectionWideOfferVerifier.wait();

    console.log(`OriginationController added CollectionWideOfferVerifier at address: ${collectionWideOfferVerifier.address} as allowed verifier`);
    console.log(SUBSECTION_SEPARATOR);

    const setArtBlocksVerifier = await originationController.setAllowedVerifiers([artBlocksVerifier.address], [true]);
    await setArtBlocksVerifier.wait();

    console.log(`OriginationController added ArtBlocksVerifier, at address ${artBlocksVerifier.address} as allowed verifier`);
    console.log(SUBSECTION_SEPARATOR);

    const setUnvaultedItemsVerifier = await originationController.setAllowedVerifiers(
        [unvaultedItemsVerifier.address],
        [true],
    );
    await setUnvaultedItemsVerifier.wait();

    console.log(
        `OriginationController added UnvaultedItemsVerifier, at address: ${unvaultedItemsVerifier.address} as allowed verifier`,
    );
    console.log(SUBSECTION_SEPARATOR);

    // grant originationContoller the owner role
    const updateOriginationControllerAdmin = await originationController.grantRole(ADMIN_ROLE, ADMIN_ADDRESS);
    await updateOriginationControllerAdmin.wait();

    // grant originationContoller the owner role
    const updateOriginationWhiteListManager = await originationController.grantRole(
        WHITELIST_MANAGER_ROLE,
        ADMIN_ADDRESS,
    );
    await updateOriginationWhiteListManager.wait();

    console.log(`OriginationController: admin role granted to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    //const renounceOriginationControllerAdmin = await originationController.renounceRole(ADMIN_ROLE, deployer.address);
    //await renounceOriginationControllerAdmin.wait();

    // NOTE:
    // originationController.renounceRole(WHITELIST_MANAGER_ROLE, deployer.address);
    // will occur in the token-whitelist.ts script because signer : deployer needs to
    // perform the whitelisting before the renounceRole txn
    // And this is why line 217 is commented out in e2e.ts

    //console.log("OriginationController: deployer has renounced admin role");
    console.log(SUBSECTION_SEPARATOR);

    // ================= VaultFactory ==================

    // grant vaultFactory admin the owner role
    const updateVaultFactoryAdmin = await factory.grantRole(ADMIN_ROLE, ADMIN_ADDRESS);
    await updateVaultFactoryAdmin.wait();

    console.log(`VaultFactory: admin role granted to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // grant vaultFactory admin fee claimer permissions
    const updateVaultFactoryFeeClaimer = await factory.grantRole(FEE_CLAIMER_ROLE, ADMIN_ADDRESS);
    await updateVaultFactoryFeeClaimer.wait();

    console.log(`VaultFactory: fee claimer role granted to ${ADMIN_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // renounce deployer permissions
    //const renounceVaultFactoryAdmin = await factory.renounceRole(ADMIN_ROLE, deployer.address);
    //await renounceVaultFactoryAdmin.wait();

    //const renounceVaultFactoryFeeClaimer = await factory.renounceRole(FEE_CLAIMER_ROLE, deployer.address);
    //await renounceVaultFactoryFeeClaimer.wait();

    //const renounceVaultFactoryResourceManager = await factory.renounceRole(RESOURCE_MANAGER_ROLE, deployer.address);
    //await renounceVaultFactoryResourceManager.wait();

    // console.log("VaultFactory: deployer has renounced admin role");
    // console.log("VaultFactory: deployer has renounced fee claimer role");
    // console.log("VaultFactory: deployer has renounced resource manager role");

    console.log("Transferred all ownership.\n");
}

async function attachAddresses(jsonFile: string): Promise<ContractArgs> {
    const readData = fs.readFileSync(jsonFile, 'utf-8');
    const jsonData = JSON.parse(readData);
    const contracts: { [key: string]: Contract } = {};

    for await (const key of Object.keys(jsonData)) {
        if (!(key in jsonContracts)) continue;

        const argKey = jsonContracts[key];
        console.log(`Key: ${key}, address: ${jsonData[key]["contractAddress"]}`);

        let contract: Contract;
        if (key === "BorrowerNote" || key === "LenderNote") {
            contract = await ethers.getContractAt("PromissoryNote", jsonData[key]["contractAddress"]);
        } else {
            contract = await ethers.getContractAt(key, jsonData[key]["contractAddress"]);
        }

        contracts[argKey] = contract;
    }

    return contracts as ContractArgs;
}

if (require.main === module) {
    // retrieve command line args array
    const [,,file] = process.argv;

    console.log("File:", file);

    // assemble args to access the relevant deplyment json in .deployment
    void attachAddresses(file).then((res: ContractArgs) => {
        const {
            whitelist,
            baseURIDescriptor,
            feeController,
            assetVault,
            factory,
            borrowerNote,
            lenderNote,
            loanCore,
            repaymentController,
            originationController,
            verifier,
            punksVerifier,
            collectionWideOfferVerifier,
            artBlocksVerifier,
            unvaultedItemsVerifer,
            callWhitelistApprovals,
            callWhitelistDelegation,
        } = res;

        main(
            whitelist,
            baseURIDescriptor,
            feeController,
            assetVault,
            factory,
            borrowerNote,
            lenderNote,
            loanCore,
            repaymentController,
            originationController,
            verifier,
            punksVerifier,
            collectionWideOfferVerifier,
            artBlocksVerifier,
            unvaultedItemsVerifer,
            callWhitelistApprovals,
            callWhitelistDelegation,
        )
            .then(() => process.exit(0))
            .catch((error: Error) => {
                console.error(error);
                process.exit(1);
            });
    });
}
