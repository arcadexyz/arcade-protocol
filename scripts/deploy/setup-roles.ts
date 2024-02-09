import { ethers } from "hardhat";
import { loadContracts, DeployedResources } from "../utils/deploy";

import {
    ORIGINATOR_ROLE,
    ADMIN_ROLE,
    FEE_CLAIMER_ROLE,
    REPAYER_ROLE,
    AFFILIATE_MANAGER_ROLE,
    RESOURCE_MANAGER_ROLE,
    WHITELIST_MANAGER_ROLE,
    ADMIN,
    RESOURCE_MANAGER,
    CALL_WHITELIST_MANAGER,
    LOAN_WHITELIST_MANAGER,
    FEE_CLAIMER,
    AFFILIATE_MANAGER,
    SUBSECTION_SEPARATOR,
    SECTION_SEPARATOR,
    SHUTDOWN_ROLE,
    SHUTDOWN_CALLER,
    MIGRATION_MANAGER_ROLE,
    MIGRATION_MANAGER,
} from "../utils/constants";
import { ContractTransaction } from "ethers";

export async function setupRoles(resources: DeployedResources): Promise<void> {
    const signers = await ethers.getSigners();
    const [deployer] = signers;

    // Set admin address
    console.log("Admin address:", ADMIN);
    console.log("Resource manager address:", RESOURCE_MANAGER);
    console.log("Call whitelist manager address:", CALL_WHITELIST_MANAGER);
    console.log("Loan whitelist manager address:", LOAN_WHITELIST_MANAGER);
    console.log("Fee claimer address:", FEE_CLAIMER);
    console.log("Affiliate manager address:", AFFILIATE_MANAGER);

    // Define roles
    const OC_MIGRATE_ADDRESS = resources.originationControllerMigrate.address;
    const LOAN_CORE_ADDRESS = resources.loanCore.address;
    const REPAYMENT_CONTROLLER_ADDRESS = resources.repaymentController.address;

    console.log(SECTION_SEPARATOR);

    let tx: ContractTransaction;

    // ============= CallWhitelist ==============

    const { whitelist } = resources;
    tx = await whitelist.grantRole(ADMIN_ROLE, ADMIN);
    await tx.wait();

    tx = await whitelist.grantRole(WHITELIST_MANAGER_ROLE, CALL_WHITELIST_MANAGER);
    await tx.wait();

    tx = await whitelist.renounceRole(ADMIN_ROLE, deployer.address);
    await tx.wait();

    console.log(`CallWhitelistAllExtensions: admin role granted to ${CALL_WHITELIST_MANAGER}`);
    console.log(`CallWhitelistAllExtensions: whitelist manager role granted to ${CALL_WHITELIST_MANAGER}`);
    console.log(`CallWhitelistAllExtensions: Deployer renounced admin role`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== vaultFactoryURIDescriptor ============

    const { vaultFactoryURIDescriptor } = resources;
    tx = await vaultFactoryURIDescriptor.transferOwnership(RESOURCE_MANAGER);
    await tx.wait();

    console.log(`VaultFactoryURIDescriptor: ownership transferred to ${RESOURCE_MANAGER}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= FeeController ==============

    const { feeController } = resources;
    tx = await feeController.transferOwnership(ADMIN);
    await tx.wait();

    console.log(`FeeController: ownership transferred to ${ADMIN}`);
    console.log(SUBSECTION_SEPARATOR);

    // ================= VaultFactory ==================

    const { vaultFactory } = resources;
    tx = await vaultFactory.grantRole(ADMIN_ROLE, ADMIN);
    await tx.wait();
    tx = await vaultFactory.grantRole(FEE_CLAIMER_ROLE, FEE_CLAIMER);
    await tx.wait();
    tx = await vaultFactory.grantRole(RESOURCE_MANAGER_ROLE, RESOURCE_MANAGER);
    await tx.wait();
    tx = await vaultFactory.renounceRole(ADMIN_ROLE, deployer.address);
    await tx.wait();
    tx = await vaultFactory.renounceRole(FEE_CLAIMER_ROLE, deployer.address);
    await tx.wait();

    console.log(`VaultFactory: admin role granted to ${ADMIN}`);
    console.log(`VaultFactory: fee claimer role granted to ${FEE_CLAIMER}`);
    console.log(`VaultFactory: resource manager role granted to ${RESOURCE_MANAGER}`);
    console.log(`VaultFactory: deployer renounced admin and fee claimer role`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== borrowerNoteURIDescriptor ============

    const { borrowerNoteURIDescriptor } = resources;
    tx = await borrowerNoteURIDescriptor.transferOwnership(RESOURCE_MANAGER);
    await tx.wait();

    console.log(`BorrowerNoteURIDescriptor: ownership transferred to ${RESOURCE_MANAGER}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= BorrowerNote ==============

    const { borrowerNote } = resources;
    tx = await borrowerNote.initialize(LOAN_CORE_ADDRESS);
    await tx.wait();

    console.log(`BorrowerNote: initialized loanCore at address ${LOAN_CORE_ADDRESS}`);

    tx = await borrowerNote.grantRole(RESOURCE_MANAGER_ROLE, RESOURCE_MANAGER);
    await tx.wait();

    tx = await borrowerNote.renounceRole(RESOURCE_MANAGER_ROLE, deployer.address);
    await tx.wait();
    console.log(`BorrowerNote: resource manager role granted to ${RESOURCE_MANAGER}`);
    console.log(`BorrowerNote: deployer renounced resource manager role`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== lenderNoteURIDescriptor ============

    const { lenderNoteURIDescriptor } = resources;
    tx = await lenderNoteURIDescriptor.transferOwnership(RESOURCE_MANAGER);
    await tx.wait();

    console.log(`LenderNoteURIDescriptor: ownership transferred to ${RESOURCE_MANAGER}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= LenderNote ==============

    const { lenderNote } = resources;
    tx = await lenderNote.initialize(LOAN_CORE_ADDRESS);
    await tx.wait();

    console.log(`LenderNote: initialized loanCore at address ${LOAN_CORE_ADDRESS}`);

    tx = await lenderNote.grantRole(RESOURCE_MANAGER_ROLE, RESOURCE_MANAGER);
    await tx.wait();

    tx = await lenderNote.renounceRole(RESOURCE_MANAGER_ROLE, deployer.address);
    await tx.wait();
    console.log(`lenderNote: resource manager role granted to ${RESOURCE_MANAGER}`);
    console.log(`lenderNote: deployer renounced resource manager role`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= LoanCore ==============

    const { loanCore } = resources;
    tx = await loanCore.grantRole(ADMIN_ROLE, ADMIN);
    await tx.wait();
    tx = await loanCore.grantRole(ORIGINATOR_ROLE, OC_MIGRATE_ADDRESS);
    await tx.wait();
    tx = await loanCore.grantRole(REPAYER_ROLE, REPAYMENT_CONTROLLER_ADDRESS);
    await tx.wait();
    tx = await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, AFFILIATE_MANAGER);
    await tx.wait();
    tx = await loanCore.grantRole(FEE_CLAIMER_ROLE, FEE_CLAIMER);
    await tx.wait();
    tx = await loanCore.grantRole(SHUTDOWN_ROLE, SHUTDOWN_CALLER);
    await tx.wait();
    tx = await loanCore.renounceRole(ADMIN_ROLE, deployer.address);
    await tx.wait();

    console.log(`LoanCore: admin role granted to ${ADMIN}`);
    console.log(`LoanCore: originator role granted to ${OC_MIGRATE_ADDRESS}`);
    console.log(`LoanCore: repayer role granted to ${REPAYMENT_CONTROLLER_ADDRESS}`);
    console.log(`LoanCore: affiliate manager role granted to ${AFFILIATE_MANAGER}`);
    console.log(`LoanCore: fee claimer role granted to ${FEE_CLAIMER}`);
    console.log(`LoanCore: shutdown role granted to ${SHUTDOWN_CALLER}`);
    console.log(`LoanCore: deployer renounced admin role`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= OriginationController ==============

    const { originationControllerMigrate } = resources;
    tx = await originationControllerMigrate.grantRole(ADMIN_ROLE, ADMIN);
    await tx.wait();
    tx = await originationControllerMigrate.grantRole(MIGRATION_MANAGER_ROLE, MIGRATION_MANAGER);
    await tx.wait();
    tx = await originationControllerMigrate.renounceRole(ADMIN_ROLE, deployer.address);
    await tx.wait();
    tx = await originationControllerMigrate.renounceRole(MIGRATION_MANAGER_ROLE, deployer.address);
    await tx.wait();

    console.log(`originationControllerMigrate: admin role granted to ${ADMIN}`);
    console.log(`originationControllerMigrate: migration manager role granted to ${LOAN_WHITELIST_MANAGER}`);
    console.log(`originationControllerMigrate: Deployer renounced admin and migration manager role`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= OriginationConfiguration ==============
    const { originationConfiguration } = resources;
    tx = await originationConfiguration.grantRole(ADMIN_ROLE, ADMIN);
    await tx.wait();
    tx = await originationConfiguration.grantRole(WHITELIST_MANAGER_ROLE, LOAN_WHITELIST_MANAGER);
    await tx.wait();
    tx = await originationConfiguration.renounceRole(ADMIN_ROLE, deployer.address);
    await tx.wait();
    tx = await originationConfiguration.renounceRole(WHITELIST_MANAGER_ROLE, deployer.address);
    await tx.wait();

    console.log(`originationConfiguration: admin role granted to ${ADMIN}`);
    console.log(`originationConfiguration: whitelist manager role granted to ${LOAN_WHITELIST_MANAGER}`);
    console.log(`originationConfiguration: Deployer renounced admin and whitelist manager role`);

    console.log("✅ Transferred all ownership.");
}

if (require.main === module) {
    // retrieve command line args array
    const file = process.env.DEPLOYMENT_FILE;

    console.log("File:", file);

    // assemble args to access the relevant deplyment json in .deployment
    void loadContracts(file!)
        .then(setupRoles)
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
