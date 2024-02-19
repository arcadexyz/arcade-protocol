import { ethers } from "hardhat"

export const EIP712_VERSION = "4";
export const SIG_DEADLINE = 1954884800;

export const ORIGINATOR_ROLE = ethers.utils.id("ORIGINATOR");
export const REPAYER_ROLE = ethers.utils.id("REPAYER");
export const ADMIN_ROLE = ethers.utils.id("ADMIN");
export const FEE_CLAIMER_ROLE = ethers.utils.id("FEE_CLAIMER");
export const AFFILIATE_MANAGER_ROLE = ethers.utils.id("AFFILIATE_MANAGER");
export const WHITELIST_MANAGER_ROLE = ethers.utils.id("WHITELIST_MANAGER");
export const MIGRATION_MANAGER_ROLE = ethers.utils.id("MIGRATION_MANAGER");
export const RESOURCE_MANAGER_ROLE = ethers.utils.id("RESOURCE_MANAGER");
export const MINT_BURN_ROLE = ethers.utils.id("MINT/BURN");
export const SHUTDOWN_ROLE = ethers.utils.id("SHUTDOWN");

export const BASE_URI = `https://s3.amazonaws.com/images.pawn.fi/test-nft-metadata/PawnBeats/`;
export const MIN_LOAN_PRINCIPAL = 1_000_000;
