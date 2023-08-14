import { ethers, BigNumber } from "ethers";

///////////////////////////////
////// MAINNET ADDRESSES //////
///////////////////////////////
export const BORROWER = "0xc2f094439cd1fc45af3e8a679984927abab0d3d9"; // user calling the rollover function
export const LOAN_COLLATERAL_ADDRESS = "0x6e9b4c2f6bd57b7b924d29b5dcfca1273ecc94a2"; // Vault Factory
export const BALANCER_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer vault

// USDC - 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
// WETH - 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
// DAI - 0x6B175474E89094C44Da98b954EedeAC495271d0F
export const PAYABLE_CURRENCY = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // WETH

// DAI Whale - 0x1Cb17a66DC606a52785f69F08F4256526aBd4943
// WETH Whale - 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
// USDC Whale - 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB
export const WHALE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // WETH Whale

///////////////////////////////
//////// V2 LOAN DATA /////////
///////////////////////////////
export const V2_BORROWER_NOTE_ADDRESS = "0x337104A4f06260Ff327d6734C555A0f5d8F863aa"; // v2 Borrower Note mainnet
export const LOAN_ID = 2514; // active v2 loanId on mainnet
export const COLLATERAL_ID = BigNumber.from("545808466085006852252029380538339101034278436457"); // vault id on mainnet
export const V2_TOTAL_REPAYMENT_AMOUNT = ethers.utils.parseUnits("2.868", 18); // old repayment amount with interest amount included

///////////////////////////////
//////// V3 LOAN DATA /////////
///////////////////////////////
export const NONCE = 1; // nonce to use in new lender's bid
export const V3_LOAN_PRINCIPAL = ethers.utils.parseUnits("2.8", 18); // new loan principal
export const V3_LOAN_INTEREST_RATE = ethers.utils.parseUnits("3.75", 18); // new loan interest rate
// collection wide offer parameters
export const LENDER_SPECIFIED_COLLATERAL_ID = 4155; // specific collection wide offer id (MILADY)
export const LENDER_SPECIFIED_COLLATERAL = "0x5af0d9827e0c53e4799bb226655a1de152a425a5" // Collection wide offer (MILADY)
