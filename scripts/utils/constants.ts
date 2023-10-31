import { ethers } from "hardhat"

export const ORIGINATOR_ROLE = ethers.utils.id("ORIGINATOR");
export const REPAYER_ROLE = ethers.utils.id("REPAYER");
export const ADMIN_ROLE = ethers.utils.id("ADMIN");
export const FEE_CLAIMER_ROLE = ethers.utils.id("FEE_CLAIMER");
export const AFFILIATE_MANAGER_ROLE = ethers.utils.id("AFFILIATE_MANAGER");
export const RESOURCE_MANAGER_ROLE = ethers.utils.id("RESOURCE_MANAGER");
export const MINT_BURN_ROLE = ethers.utils.id("MINT_BURN");
export const WHITELIST_MANAGER_ROLE = ethers.utils.id("WHITELIST_MANAGER");
export const MIGRATION_MANAGER_ROLE = ethers.utils.id("MIGRATION_MANAGER");
export const SHUTDOWN_ROLE = ethers.utils.id("SHUTDOWN");

export const SECTION_SEPARATOR = "\n" + "=".repeat(80) + "\n";
export const SUBSECTION_SEPARATOR = "-".repeat(10);

export const PUNKS_ADDRESS = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB";
export const DELEGATION_REGISTRY_ADDRESS = "0x00000000000076a84fef008cdabe6409d2fe638b" // same on all networks

// export const VAULT_FACTORY_BASE_URI = "ipfs://QmZqGmFmhHviRnzMadzoJn9kc5zx3XBGVQMaBMU4xVZVoQ"; // goerli
export const VAULT_FACTORY_BASE_URI = "ipfs://QmZxV2PRMeNjuy5eK3ZUjLj3sSTaU5FsoZnzBebeCrSU2v"; // mainnet

// export const BORROWER_NOTE_BASE_URI = "ipfs://QmP33FAzZYMaNaUiNhok89bBKzEzq1qQ6LQ6FLbBFZprcc"; // goerli
export const BORROWER_NOTE_BASE_URI = "ipfs://QmNPVoEPopKHC1sEnkUCw3HJkxCkgbtw9EzMpu5HXJHrh3"; // mainnet
export const BORROWER_NOTE_NAME = "Arcade.xyz Borrower Note";
export const BORROWER_NOTE_SYMBOL = "aBN";

// export const LENDER_NOTE_BASE_URI = "ipfs://QmSoqN1QskJRwrrdG867NjWdwsXkUmEcmMK1MmNUoEdHps"; // goerli
export const LENDER_NOTE_BASE_URI = "ipfs://QmTKTPKZx6qTnVJZxo1SYr53woDtMLZjuy1qPukknTEbQZ"; // mainnet
export const LENDER_NOTE_NAME = "Arcade.xyz Lender Note";
export const LENDER_NOTE_SYMBOL = "aLN";

export const OLD_ADMIN = "0x398e92C827C5FA0F33F171DC8E20570c5CfF330e";

// To fill in after deployment
export const ADMIN = "0x54B7235dB74103395dD48A2c3dd993E3b7d39856";                      // ArcadeCoreVoting
export const RESOURCE_MANAGER = "0x398e92C827C5FA0F33F171DC8E20570c5CfF330e";           // Launch Partner Multisig
export const CALL_WHITELIST_MANAGER = "0x398e92C827C5FA0F33F171DC8E20570c5CfF330e";     // Launch Partner Multisig
export const LOAN_WHITELIST_MANAGER = "0x54B7235dB74103395dD48A2c3dd993E3b7d39856";     // ArcadeCoreVoting
export const MIGRATION_MANAGER = "0xE004727641b3C9A2441eE21fa73BEc51f6029543";          // Foundation Multisig
export const FEE_CLAIMER = "0x54B7235dB74103395dD48A2c3dd993E3b7d39856";                // ArcadeCoreVoting
export const AFFILIATE_MANAGER = "0x2b6F11B2A783C928799C4E561dA89cD06894A279";          // ArcadeGSCCoreVoting
export const SHUTDOWN_CALLER = "0xE004727641b3C9A2441eE21fa73BEc51f6029543";            // Foundation Multisig

export const allowedCurrencies = [
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",       // WETH
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",       // WBTC
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",       // USDC
    "0x6B175474E89094C44Da98b954EedeAC495271d0F",       // DAI
    "0x4d224452801ACEd8B2F0aebE155379bb5D594381",       // APE
];

export const minPrincipals = [
    ethers.utils.parseEther("0.0001"),      // WETH
    ethers.utils.parseUnits("0.00001", 8),  // WBTC
    ethers.utils.parseUnits("1", 6),        // USDC
    ethers.utils.parseEther("1"),           // DAI
    ethers.utils.parseEther("0.0001"),      // APE
];
