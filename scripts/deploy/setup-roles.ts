import { loadContracts, ContractArgs } from "../utils/deploy";

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
    SECTION_SEPARATOR
} from "../utils/constants";

export async function setupRoles(resources: ContractArgs): Promise<void> {
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
    const ORIGINATION_CONTROLLER_ADDRESS = resources.originationController.address;
    const LOAN_CORE_ADDRESS = resources.loanCore.address;
    const REPAYMENT_CONTROLLER_ADDRESS = resources.repaymentController.address;

    console.log(SECTION_SEPARATOR);

    // ============= CallWhitelist ==============

    const { whitelist } = resources;
    await whitelist.grantRole(ADMIN_ROLE, ADMIN);
    await whitelist.grantRole(WHITELIST_MANAGER_ROLE, CALL_WHITELIST_MANAGER);
    await whitelist.renounceRole(ADMIN_ROLE, deployer.address);

    console.log(`CallWhitelistAllExtensions: admin role granted to ${CALL_WHITELIST_MANAGER}`);
    console.log(`CallWhitelistAllExtensions: whitelist manager role granted to ${CALL_WHITELIST_MANAGER}`);
    console.log(`CallWhitelistAllExtensions: Deployer renounced admin role`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== vaultFactoryURIDescriptor ============

    const { vaultFactoryURIDescriptor } = resources;
    await vaultFactoryURIDescriptor.transferOwnership(RESOURCE_MANAGER);

    console.log(`VaultFactoryURIDescriptor: ownership transferred to ${RESOURCE_MANAGER}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= FeeController ==============

    const { feeController } = resources;
    await feeController.transferOwnership(ADMIN);

    console.log(`FeeController: ownership transferred to ${ADMIN}`);
    console.log(SUBSECTION_SEPARATOR);

    // ================= VaultFactory ==================

    const { vaultFactory } = resources;
    await vaultFactory.grantRole(ADMIN_ROLE, ADMIN);
    await vaultFactory.grantRole(FEE_CLAIMER_ROLE, FEE_CLAIMER);
    await vaultFactory.grantRole(RESOURCE_MANAGER_ROLE, RESOURCE_MANAGER);
    await vaultFactory.renounceRole(ADMIN_ROLE, deployer.address);
    await vaultFactory.renounceRole(FEE_CLAIMER_ROLE, deployer.address);

    console.log(`VaultFactory: admin role granted to ${ADMIN}`);
    console.log(`VaultFactory: fee claimer role granted to ${FEE_CLAIMER}`);
    console.log(`VaultFactory: resource manager role granted to ${RESOURCE_MANAGER}`);
    console.log(`VaultFactory: deployer renounced admin and fee claimer role`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== borrowerNoteURIDescriptor ============

    const { borrowerNoteURIDescriptor } = resources;
    console.log(borrowerNoteURIDescriptor.address);
    await borrowerNoteURIDescriptor.transferOwnership(RESOURCE_MANAGER);

    console.log(`BorrowerNoteURIDescriptor: ownership transferred to ${RESOURCE_MANAGER}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= BorrowerNote ==============

    const { borrowerNote } = resources;
    await borrowerNote.initialize(LOAN_CORE_ADDRESS);

    console.log(`BorrowerNote: initialized loanCore at address ${LOAN_CORE_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== lenderNoteURIDescriptor ============

    const { lenderNoteURIDescriptor } = resources;
    await lenderNoteURIDescriptor.transferOwnership(RESOURCE_MANAGER);

    console.log(`LenderNoteURIDescriptor: ownership transferred to ${RESOURCE_MANAGER}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= LenderNote ==============

    const { lenderNote } = resources;
    await lenderNote.initialize(LOAN_CORE_ADDRESS);

    console.log(`LenderNote: initialized loanCore at address ${LOAN_CORE_ADDRESS}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= LoanCore ==============

    const { loanCore } = resources;
    await loanCore.grantRole(ADMIN_ROLE, ADMIN);
    await loanCore.grantRole(ORIGINATOR_ROLE, ORIGINATION_CONTROLLER_ADDRESS);
    await loanCore.grantRole(REPAYER_ROLE, REPAYMENT_CONTROLLER_ADDRESS);
    await loanCore.grantRole(AFFILIATE_MANAGER_ROLE, AFFILIATE_MANAGER);
    await loanCore.grantRole(FEE_CLAIMER_ROLE, FEE_CLAIMER);
    await loanCore.renounceRole(ADMIN_ROLE, deployer.address);

    console.log(`LoanCore: admin role granted to ${ADMIN}`);
    console.log(`LoanCore: originator role granted to ${ORIGINATION_CONTROLLER_ADDRESS}`);
    console.log(`LoanCore: repayer role granted to ${REPAYMENT_CONTROLLER_ADDRESS}`);
    console.log(`LoanCore: affiliate manager role granted to ${AFFILIATE_MANAGER}`);
    console.log(`LoanCore: fee claimer role granted to ${FEE_CLAIMER}`);
    console.log(`LoanCore: deployer renounced admin role`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= OriginationController ==============

    const { originationController } = resources;
    await originationController.grantRole(ADMIN_ROLE, ADMIN);
    await originationController.grantRole(WHITELIST_MANAGER_ROLE, LOAN_WHITELIST_MANAGER);
    await originationController.renounceRole(ADMIN_ROLE, deployer.address);
    await originationController.renounceRole(WHITELIST_MANAGER_ROLE, deployer.address);

    console.log(`OriginationController: admin role granted to ${ADMIN}`);
    console.log(`OriginationController: whitelist manager role granted to ${LOAN_WHITELIST_MANAGER}`);
    console.log(`OriginationController: Deployer renounced admin and whitelist manager role`);
    console.log(SUBSECTION_SEPARATOR);

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
