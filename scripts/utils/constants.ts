import { ethers } from "hardhat"

export const ORIGINATOR_ROLE = ethers.utils.id("ORIGINATOR");
export const REPAYER_ROLE = ethers.utils.id("REPAYER");
export const ADMIN_ROLE = ethers.utils.id("ADMIN");
export const FEE_CLAIMER_ROLE = ethers.utils.id("FEE_CLAIMER");
export const AFFILIATE_MANAGER_ROLE = ethers.utils.id("AFFILIATE_MANAGER");
export const RESOURCE_MANAGER_ROLE = ethers.utils.id("RESOURCE_MANAGER");
export const MINT_BURN_ROLE = ethers.utils.id("MINT_BURN");
export const WHITELIST_MANAGER_ROLE = ethers.utils.id("WHITELIST_MANAGER");
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

export const ADMIN = "0xd5EF724e342e7bc551A24Ae9C3ac324b3a16CF0d";
export const RESOURCE_MANAGER = ADMIN;
export const CALL_WHITELIST_MANAGER = ADMIN;
export const LOAN_WHITELIST_MANAGER = ADMIN;
export const FEE_CLAIMER = ADMIN;
export const AFFILIATE_MANAGER = ADMIN;
export const SHUTDOWN_CALLER = ADMIN;

export const allowedCurrencies = [
    "0x4200000000000000000000000000000000000006",       // WETH
    "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452",       // wstETH
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",       // USDC
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",       // DAI
    "0x1A37249C4209A6fc1A8f531BaA6Cd3Dda027FC64",       // ARCD (base)
];

export const minPrincipals = [
    ethers.utils.parseEther("0.0001"),      // WETH
    ethers.utils.parseEther("0.0001"),      // wstETH
    ethers.utils.parseUnits("1", 6),        // USDC
    ethers.utils.parseEther("1"),           // DAI
    ethers.utils.parseEther("1"),           // ARCD
];
