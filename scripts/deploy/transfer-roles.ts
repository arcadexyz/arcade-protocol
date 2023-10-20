import fs from "fs";
import path from "path";

import { loadContracts, DeployedResources } from "../utils/deploy";

import {
    ORIGINATOR_ROLE,
    ADMIN_ROLE,
    FEE_CLAIMER_ROLE,
    REPAYER_ROLE,
    AFFILIATE_MANAGER_ROLE,
    RESOURCE_MANAGER_ROLE,
    WHITELIST_MANAGER_ROLE,
    OLD_ADMIN,
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
} from "../utils/constants";

export interface TxData {
    index: number;
    contractName: string;
    to: string;
    functionName: string;
    description: string;
    calldata: string;
}

export async function setupRoles(resources: DeployedResources): Promise<void> {
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

    const txs: TxData[] = [];

    // ============= CallWhitelist ==============

    let calldata: string;
    let index = 0;

    const { whitelist } = resources;

    calldata = whitelist.interface.encodeFunctionData(
        "grantRole",
        [ADMIN_ROLE, ADMIN]
    );

    txs.push({
        index: index++,
        contractName: "CallWhitelistAllExtensions",
        to: whitelist.address,
        functionName: "grantRole",
        description: "Grant the admin role",
        calldata
    });

    calldata = whitelist.interface.encodeFunctionData(
        "grantRole",
        [WHITELIST_MANAGER_ROLE, CALL_WHITELIST_MANAGER]
    );

    txs.push({
        index: index++,
        contractName: "CallWhitelistAllExtensions",
        to: whitelist.address,
        functionName: "grantRole",
        description: "Grant the whitelist manager role",
        calldata
    });

    calldata = whitelist.interface.encodeFunctionData(
        "renounceRole",
        [ADMIN_ROLE, OLD_ADMIN]
    );

    txs.push({
        index: index++,
        contractName: "CallWhitelistAllExtensions",
        to: whitelist.address,
        functionName: "renounceRole",
        description: "Current owner renounces admin role",
        calldata
    });

    calldata = whitelist.interface.encodeFunctionData(
        "renounceRole",
        [WHITELIST_MANAGER_ROLE, OLD_ADMIN]
    );

    txs.push({
        index: index++,
        contractName: "CallWhitelistAllExtensions",
        to: whitelist.address,
        functionName: "renounceRole",
        description: "Current owner renounces whitelist manager role",
        calldata
    });

    console.log(`CallWhitelistAllExtensions: admin role to be granted to ${CALL_WHITELIST_MANAGER}`);
    console.log(`CallWhitelistAllExtensions: whitelist manager role to be granted to ${CALL_WHITELIST_MANAGER}`);
    console.log(`CallWhitelistAllExtensions: old admin to renounce admin role`);
    console.log(`CallWhitelistAllExtensions: old admin to renounce whitelist manager role`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== vaultFactoryURIDescriptor ============

    const { vaultFactoryURIDescriptor } = resources;
    calldata = vaultFactoryURIDescriptor.interface.encodeFunctionData("transferOwnership", [RESOURCE_MANAGER]);
    txs.push({
        index: index++,
        contractName: "VaultFactoryURIDescriptor",
        to: vaultFactoryURIDescriptor.address,
        functionName: "transferOwnership",
        description: "Transfer ownership to resource manager",
        calldata
    });

    console.log(`VaultFactoryURIDescriptor: ownership to be transferred to ${RESOURCE_MANAGER}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= FeeController ==============

    const { feeController } = resources;
    calldata = feeController.interface.encodeFunctionData("transferOwnership", [ADMIN]);
    txs.push({
        index: index++,
        contractName: "FeeController",
        to: feeController.address,
        functionName: "transferOwnership",
        description: "Transfer ownership to admin",
        calldata
    });

    console.log(`FeeController: ownership to be transferred to ${ADMIN}`);
    console.log(SUBSECTION_SEPARATOR);

    // ================= VaultFactory ==================

    const { vaultFactory } = resources;
    calldata = vaultFactory.interface.encodeFunctionData("grantRole", [ADMIN_ROLE, ADMIN]);
    txs.push({
        index: index++,
        contractName: "VaultFactory",
        to: vaultFactory.address,
        functionName: "grantRole",
        description: "Grant the admin role",
        calldata
    });

    calldata = vaultFactory.interface.encodeFunctionData("grantRole", [FEE_CLAIMER_ROLE, FEE_CLAIMER]);
    txs.push({
        index: index++,
        contractName: "VaultFactory",
        to: vaultFactory.address,
        functionName: "grantRole",
        description: "Grant the fee claimer role",
        calldata
    });

    calldata = vaultFactory.interface.encodeFunctionData("grantRole", [RESOURCE_MANAGER_ROLE, RESOURCE_MANAGER]);
    txs.push({
        index: index++,
        contractName: "VaultFactory",
        to: vaultFactory.address,
        functionName: "grantRole",
        description: "Grant the resource manager role",
        calldata
    });

    calldata = vaultFactory.interface.encodeFunctionData("renounceRole", [ADMIN_ROLE, OLD_ADMIN]);
    txs.push({
        index: index++,
        contractName: "VaultFactory",
        to: vaultFactory.address,
        functionName: "renounceRole",
        description: "Current owner renounces admin role",
        calldata
    });

    calldata = vaultFactory.interface.encodeFunctionData("renounceRole", [FEE_CLAIMER_ROLE, OLD_ADMIN]);
    txs.push({
        index: index++,
        contractName: "VaultFactory",
        to: vaultFactory.address,
        functionName: "renounceRole",
        description: "Current owner renounces admin role",
        calldata
    });

    calldata = vaultFactory.interface.encodeFunctionData("renounceRole", [RESOURCE_MANAGER_ROLE, OLD_ADMIN]);
    txs.push({
        index: index++,
        contractName: "VaultFactory",
        to: vaultFactory.address,
        functionName: "renounceRole",
        description: "Current owner renounces resource manager role",
        calldata
    });

    console.log(`VaultFactory: admin role to be granted to ${ADMIN}`);
    console.log(`VaultFactory: fee claimer role to be granted to ${FEE_CLAIMER}`);
    console.log(`VaultFactory: resource manager role to be granted to ${RESOURCE_MANAGER}`);
    console.log(`VaultFactory: old admin to renounce admin fee claimer, and resource manager role`);
    console.log(SUBSECTION_SEPARATOR);

    // =========== borrowerNoteURIDescriptor ============

    const { borrowerNoteURIDescriptor } = resources;
    calldata = borrowerNoteURIDescriptor.interface.encodeFunctionData("transferOwnership", [RESOURCE_MANAGER]);
    txs.push({
        index: index++,
        contractName: "BorrowerNoteURIDescriptor",
        to: borrowerNoteURIDescriptor.address,
        functionName: "transferOwnership",
        description: "Transfer ownership to resource manager",
        calldata
    });

    console.log(`BorrowerNoteURIDescriptor: ownership to be transferred to ${RESOURCE_MANAGER}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= BorrowerNote ==============

    const { borrowerNote } = resources;
    calldata = borrowerNote.interface.encodeFunctionData("grantRole", [RESOURCE_MANAGER_ROLE, RESOURCE_MANAGER]);
    txs.push({
        index: index++,
        contractName: "BorrowerNote",
        to: borrowerNote.address,
        functionName: "grantRole",
        description: "Grant the resource manager role",
        calldata
    });

    const borrowerNoteAdmin = await borrowerNote.getRoleMember(RESOURCE_MANAGER_ROLE, 0);
    calldata = borrowerNote.interface.encodeFunctionData("renounceRole", [RESOURCE_MANAGER_ROLE, borrowerNoteAdmin]);
    txs.push({
        index: index++,
        contractName: "BorrowerNote",
        to: borrowerNote.address,
        functionName: "renounceRole",
        description: "Current owner renounces resource manager role",
        calldata
    });

    console.log(`BorrowerNote: resource manager role to be granted to ${RESOURCE_MANAGER}`);
    console.log(`BorrowerNote: old admin to renounce resource manager role`);

    // =========== lenderNoteURIDescriptor ============

    const { lenderNoteURIDescriptor } = resources;
    calldata = lenderNoteURIDescriptor.interface.encodeFunctionData("transferOwnership", [RESOURCE_MANAGER]);
    txs.push({
        index: index++,
        contractName: "LenderNoteURIDescriptor",
        to: lenderNoteURIDescriptor.address,
        functionName: "transferOwnership",
        description: "Transfer ownership to resource manager",
        calldata
    });

    console.log(`LenderNoteURIDescriptor: ownership to be transferred to ${RESOURCE_MANAGER}`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= LenderNote ==============

    const { lenderNote } = resources;
    calldata = lenderNote.interface.encodeFunctionData("grantRole", [RESOURCE_MANAGER_ROLE, RESOURCE_MANAGER]);
    txs.push({
        index: index++,
        contractName: "LenderNote",
        to: lenderNote.address,
        functionName: "grantRole",
        description: "Grant the resource manager role",
        calldata
    });

    const lenderNoteAdmin = await lenderNote.getRoleMember(RESOURCE_MANAGER_ROLE, 0);
    calldata = lenderNote.interface.encodeFunctionData("renounceRole", [RESOURCE_MANAGER_ROLE, lenderNoteAdmin]);
    txs.push({
        index: index++,
        contractName: "LenderNote",
        to: lenderNote.address,
        functionName: "renounceRole",
        description: "Current owner renounces resource manager role",
        calldata
    });

    console.log(`LenderNote: resource manager role to be granted to ${RESOURCE_MANAGER}`);
    console.log(`LenderNote: old admin to renounce resource manager role`);

    // ============= LoanCore ==============

    const { loanCore } = resources;
    calldata = loanCore.interface.encodeFunctionData(
        "grantRole",
        [ADMIN_ROLE, ADMIN]
    );
    txs.push({
        index: index++,
        contractName: "LoanCore",
        to: loanCore.address,
        functionName: "grantRole",
        description: "Grant the admin role",
        calldata
    });

    calldata = loanCore.interface.encodeFunctionData(
        "grantRole",
        [AFFILIATE_MANAGER_ROLE, AFFILIATE_MANAGER]
    );
    txs.push({
        index: index++,
        contractName: "LoanCore",
        to: loanCore.address,
        functionName: "grantRole",
        description: "Grant the affiliate manager role",
        calldata
    });

    calldata = loanCore.interface.encodeFunctionData(
        "grantRole",
        [FEE_CLAIMER_ROLE, FEE_CLAIMER]
    );
    txs.push({
        index: index++,
        contractName: "LoanCore",
        to: loanCore.address,
        functionName: "grantRole",
        description: "Grant the fee claimer role",
        calldata
    });

    calldata = loanCore.interface.encodeFunctionData(
        "grantRole",
        [SHUTDOWN_ROLE, SHUTDOWN_CALLER]
    );
    txs.push({
        index: index++,
        contractName: "LoanCore",
        to: loanCore.address,
        functionName: "grantRole",
        description: "Grant the shutdown role",
        calldata
    });

    calldata = loanCore.interface.encodeFunctionData(
        "renounceRole",
        [ADMIN_ROLE, OLD_ADMIN]
    );
    txs.push({
        index: index++,
        contractName: "LoanCore",
        to: loanCore.address,
        functionName: "renounceRole",
        description: "Current owner renounces admin role",
        calldata
    });

    calldata = loanCore.interface.encodeFunctionData(
        "renounceRole",
        [AFFILIATE_MANAGER_ROLE, OLD_ADMIN]
    );
    txs.push({
        index: index++,
        contractName: "LoanCore",
        to: loanCore.address,
        functionName: "renounceRole",
        description: "Current owner renounces affiliate manager role",
        calldata
    });

    calldata = loanCore.interface.encodeFunctionData(
        "renounceRole",
        [FEE_CLAIMER_ROLE, OLD_ADMIN]
    );
    txs.push({
        index: index++,
        contractName: "LoanCore",
        to: loanCore.address,
        functionName: "renounceRole",
        description: "Current owner renounces fee claimer role",
        calldata
    });

    calldata = loanCore.interface.encodeFunctionData(
        "renounceRole",
        [SHUTDOWN_ROLE, OLD_ADMIN]
    );
    txs.push({
        index: index++,
        contractName: "LoanCore",
        to: loanCore.address,
        functionName: "renounceRole",
        description: "Current owner renounces shutdown role",
        calldata
    });

    console.log(`LoanCore: admin role to be granted to ${ADMIN}`);
    console.log(`LoanCore: originator role to be granted to ${ORIGINATION_CONTROLLER_ADDRESS}`);
    console.log(`LoanCore: repayer role to be granted to ${REPAYMENT_CONTROLLER_ADDRESS}`);
    console.log(`LoanCore: affiliate manager role to be granted to ${AFFILIATE_MANAGER}`);
    console.log(`LoanCore: fee claimer role to be granted to ${FEE_CLAIMER}`);
    console.log(`LoanCore: shutdown role to be granted to ${SHUTDOWN_CALLER}`);
    console.log(`LoanCore: old admin to renounce admin, affiliate manager, fee claimer, shutdown roles`);
    console.log(SUBSECTION_SEPARATOR);

    // ============= OriginationController ==============

    const { originationController } = resources;
    calldata = originationController.interface.encodeFunctionData(
        "grantRole",
        [ADMIN_ROLE, ADMIN]
    );
    txs.push({
        index: index++,
        contractName: "OriginationController",
        to: originationController.address,
        functionName: "grantRole",
        description: "Grant the admin role",
        calldata
    });

    calldata = originationController.interface.encodeFunctionData(
        "grantRole",
        [WHITELIST_MANAGER_ROLE, LOAN_WHITELIST_MANAGER]
    );
    txs.push({
        index: index++,
        contractName: "OriginationController",
        to: originationController.address,
        functionName: "grantRole",
        description: "Grant the whitelist manager role",
        calldata
    });

    calldata = originationController.interface.encodeFunctionData(
        "renounceRole",
        [ADMIN_ROLE, OLD_ADMIN]
    );
    txs.push({
        index: index++,
        contractName: "OriginationController",
        to: originationController.address,
        functionName: "renounceRole",
        description: "Current owner renounces admin role",
        calldata
    });

    calldata = originationController.interface.encodeFunctionData(
        "renounceRole",
        [WHITELIST_MANAGER_ROLE, OLD_ADMIN]
    );
    txs.push({
        index: index++,
        contractName: "OriginationController",
        to: originationController.address,
        functionName: "renounceRole",
        description: "Current owner renounces whitelist manager role",
        calldata
    });

    console.log(`OriginationController: admin role to be granted to ${ADMIN}`);
    console.log(`OriginationController: whitelist manager role to be granted to ${LOAN_WHITELIST_MANAGER}`);
    console.log(`OriginationController: old admin to renounce admin and whitelist manager role`);
    console.log(SUBSECTION_SEPARATOR);

    const file = process.env.DEPLOYMENT_FILE;
    const filepath = file!.split("/");
    filepath.splice(-1);

    const newFile = path.join(...filepath, "transfer-roles.json");

    fs.writeFileSync(newFile, JSON.stringify(txs, null, 4));

    console.log("✅ All role transfers recorded.");
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
