import { ethers } from "hardhat"

export const ORIGINATOR_ROLE = ethers.utils.id("ORIGINATOR");
export const REPAYER_ROLE = ethers.utils.id("REPAYER");
export const ADMIN_ROLE = ethers.utils.id("ADMIN");
export const FEE_CLAIMER_ROLE = ethers.utils.id("FEE_CLAIMER");
export const AFFILIATE_MANAGER_ROLE = ethers.utils.id("AFFILIATE_MANAGER");
export const RESOURCE_MANAGER_ROLE = ethers.utils.id("RESOURCE_MANAGER");
export const MINT_BURN_ROLE = ethers.utils.id("MINT_BURN");
export const WHITELIST_MANAGER_ROLE = ethers.utils.id("WHITELIST_MANAGER");

export const SECTION_SEPARATOR = "\n" + "=".repeat(80) + "\n";
export const SUBSECTION_SEPARATOR = "-".repeat(10);

export const PUNKS_ADDRESS = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB";
export const DELEGATION_REGISTRY_ADDRESS = "0x00000000000076a84fef008cdabe6409d2fe638b" // same on all networks

export const VAULT_FACTORY_BASE_URI = `https://s3.amazonaws.com/images.pawn.fi/test-nft-metadata/PawnBeats/`;

export const BORROWER_NOTE_BASE_URI = `https://s3.amazonaws.com/images.pawn.fi/test-nft-metadata/PawnBeats/`;
export const BORROWER_NOTE_NAME = "Arcade.xyz Borrower Note";
export const BORROWER_NOTE_SYMBOL = "aBN";

export const LENDER_NOTE_BASE_URI = `https://s3.amazonaws.com/images.pawn.fi/test-nft-metadata/PawnBeats/`;
export const LENDER_NOTE_NAME = "Arcade.xyz Lender Note";
export const LENDER_NOTE_SYMBOL = "aBN";

export const ADMIN = "0xAdD93e738a415c5248f7cB044FCFC71d86b18572"; // in prod - will always be CV-owned timelock
export const RESOURCE_MANAGER = ADMIN; // core voting or delegated "low-security" multisig - controls NFT image
export const CALL_WHITELIST_MANAGER = ADMIN; // core voting - adds vault utility via adding/removing function calls from CallWhitelist
export const LOAN_WHITELIST_MANAGER = ADMIN; // core voting - manages OriginationController
export const FEE_CLAIMER = ADMIN; // core voting or delegated "high-security" multisig/smart contract
export const AFFILIATE_MANAGER = ADMIN // core voting