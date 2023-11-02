import { ethers, BigNumber } from "ethers";

///////////////////////////////
////// MAINNET ADDRESSES //////
///////////////////////////////
export const BORROWER = "0x2B6C7d09C6c28a027b38A2721C3f4bD3C61Af964"; // user calling the rollover function
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
//////// NFTFI LOAN DATA //////
///////////////////////////////
export const LOAN_ID = 42595; // nftfi loanId on mainnet: https://etherscan.io/address/0xE52Cec0E90115AbeB3304BaA36bc2655731f7934#readContract
export const NFTFI_OBLIGATION_RECEIPT_TOKEN_ADDRESS = "0xe73ECe5988FfF33a012CEA8BB6Fd5B27679fC481";
export const NFTFI_SMARTNFT_ID = "7887776219097948710"; // https://etherscan.io/nft/0x5660e206496808f7b5cdb8c56a696a96ae5e9b23/8367243638575900279
export const NFTFI_REPAYMENT_AMOUNT = ethers.utils.parseUnits("22.37304553045859", 18);

export const NFTFI_V2 = [
    "0xf896527c49b44aAb3Cf22aE356Fa3AF8E331F280",
    "0x0C90C8B4aa8549656851964d5fB787F0e4F54082"
];

export const NFTFI_V2_1 = [
    "0x8252Df1d8b29057d1Afe3062bf5a64D503152BC8",
    "0x0C90C8B4aa8549656851964d5fB787F0e4F54082"
];

export const NFTFI_V2_3 = [
    "0xd0a40eB7FD94eE97102BA8e9342243A2b2E22207",
    "0x329E090aCE410aC8D86f1f0c2a13486884E7072a"
];

export const NFTFI_COLLECTION_V2 = [
    "0xE52Cec0E90115AbeB3304BaA36bc2655731f7934",
    "0x0c90c8b4aa8549656851964d5fb787f0e4f54082"
]

export const NFTFI_COLLECTION_V2_3 = [
    "0xD0C6e59B50C32530C627107F50Acc71958C4341F",
    "0x329E090aCE410aC8D86f1f0c2a13486884E7072a"
]

///////////////////////////////
//////// V3 LOAN DATA /////////
///////////////////////////////
export const NONCE = 1; // nonce to use in new lender's bid
export const V3_LOAN_PRINCIPAL = ethers.utils.parseUnits("25.0", 18); // new loan principal
export const V3_LOAN_INTEREST_RATE = ethers.utils.parseUnits("2.75", 18); // new loan interest rate
// collection wide offer parameters
export const LENDER_SPECIFIED_COLLATERAL_ID = 8170;
export const LENDER_SPECIFIED_COLLATERAL = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d"; // BAYC
export const MIN_LOAN_PRINCIPAL = ethers.utils.parseUnits("22.0", 18);;

///////////////////////////////
//// NFTFI CONTRACT ABIS /////
///////////////////////////////
export const DIRECT_LOAN_FIXED_OFFER_ABI = [
    {
        inputs: [
            { internalType: "address", name: "_admin", type: "address" },
            { internalType: "address", name: "_nftfiHub", type: "address" },
            { internalType: "address[]", name: "_permittedErc20s", type: "address[]" },
        ],
        stateMutability: "nonpayable",
        type: "constructor",
    },
    {
        anonymous: false,
        inputs: [{ indexed: false, internalType: "uint16", name: "newAdminFee", type: "uint16" }],
        name: "AdminFeeUpdated",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "address", name: "erc20Contract", type: "address" },
            { indexed: false, internalType: "bool", name: "isPermitted", type: "bool" },
        ],
        name: "ERC20Permit",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "uint32", name: "loanId", type: "uint32" },
            { indexed: true, internalType: "address", name: "borrower", type: "address" },
            { indexed: true, internalType: "address", name: "lender", type: "address" },
            { indexed: false, internalType: "uint256", name: "loanPrincipalAmount", type: "uint256" },
            { indexed: false, internalType: "uint256", name: "nftCollateralId", type: "uint256" },
            { indexed: false, internalType: "uint256", name: "loanMaturityDate", type: "uint256" },
            { indexed: false, internalType: "uint256", name: "loanLiquidationDate", type: "uint256" },
            { indexed: false, internalType: "address", name: "nftCollateralContract", type: "address" },
        ],
        name: "LoanLiquidated",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "uint32", name: "loanId", type: "uint32" },
            { indexed: true, internalType: "address", name: "borrower", type: "address" },
            { indexed: true, internalType: "address", name: "lender", type: "address" },
            { indexed: false, internalType: "uint32", name: "newLoanDuration", type: "uint32" },
            { indexed: false, internalType: "uint256", name: "newMaximumRepaymentAmount", type: "uint256" },
            { indexed: false, internalType: "uint256", name: "renegotiationFee", type: "uint256" },
            { indexed: false, internalType: "uint256", name: "renegotiationAdminFee", type: "uint256" },
        ],
        name: "LoanRenegotiated",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "uint32", name: "loanId", type: "uint32" },
            { indexed: true, internalType: "address", name: "borrower", type: "address" },
            { indexed: true, internalType: "address", name: "lender", type: "address" },
            { indexed: false, internalType: "uint256", name: "loanPrincipalAmount", type: "uint256" },
            { indexed: false, internalType: "uint256", name: "nftCollateralId", type: "uint256" },
            { indexed: false, internalType: "uint256", name: "amountPaidToLender", type: "uint256" },
            { indexed: false, internalType: "uint256", name: "adminFee", type: "uint256" },
            { indexed: false, internalType: "uint256", name: "revenueShare", type: "uint256" },
            { indexed: false, internalType: "address", name: "revenueSharePartner", type: "address" },
            { indexed: false, internalType: "address", name: "nftCollateralContract", type: "address" },
            { indexed: false, internalType: "address", name: "loanERC20Denomination", type: "address" },
        ],
        name: "LoanRepaid",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "uint32", name: "loanId", type: "uint32" },
            { indexed: true, internalType: "address", name: "borrower", type: "address" },
            { indexed: true, internalType: "address", name: "lender", type: "address" },
            {
                components: [
                    { internalType: "uint256", name: "loanPrincipalAmount", type: "uint256" },
                    { internalType: "uint256", name: "maximumRepaymentAmount", type: "uint256" },
                    { internalType: "uint256", name: "nftCollateralId", type: "uint256" },
                    { internalType: "address", name: "loanERC20Denomination", type: "address" },
                    { internalType: "uint32", name: "loanDuration", type: "uint32" },
                    { internalType: "uint16", name: "loanInterestRateForDurationInBasisPoints", type: "uint16" },
                    { internalType: "uint16", name: "loanAdminFeeInBasisPoints", type: "uint16" },
                    { internalType: "address", name: "nftCollateralWrapper", type: "address" },
                    { internalType: "uint64", name: "loanStartTime", type: "uint64" },
                    { internalType: "address", name: "nftCollateralContract", type: "address" },
                    { internalType: "address", name: "borrower", type: "address" },
                ],
                indexed: false,
                internalType: "struct LoanData.LoanTerms",
                name: "loanTerms",
                type: "tuple",
            },
            {
                components: [
                    { internalType: "address", name: "revenueSharePartner", type: "address" },
                    { internalType: "uint16", name: "revenueShareInBasisPoints", type: "uint16" },
                    { internalType: "uint16", name: "referralFeeInBasisPoints", type: "uint16" },
                ],
                indexed: false,
                internalType: "struct LoanData.LoanExtras",
                name: "loanExtras",
                type: "tuple",
            },
        ],
        name: "LoanStarted",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [{ indexed: false, internalType: "uint256", name: "newMaximumLoanDuration", type: "uint256" }],
        name: "MaximumLoanDurationUpdated",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "address", name: "previousOwner", type: "address" },
            { indexed: true, internalType: "address", name: "newOwner", type: "address" },
        ],
        name: "OwnershipTransferred",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [{ indexed: false, internalType: "address", name: "account", type: "address" }],
        name: "Paused",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [{ indexed: false, internalType: "address", name: "account", type: "address" }],
        name: "Unpaused",
        type: "event",
    },
    {
        inputs: [],
        name: "HUNDRED_PERCENT",
        outputs: [{ internalType: "uint16", name: "", type: "uint16" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "LOAN_COORDINATOR",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "LOAN_TYPE",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "pure",
        type: "function",
    },
    {
        inputs: [
            {
                components: [
                    { internalType: "uint256", name: "loanPrincipalAmount", type: "uint256" },
                    { internalType: "uint256", name: "maximumRepaymentAmount", type: "uint256" },
                    { internalType: "uint256", name: "nftCollateralId", type: "uint256" },
                    { internalType: "address", name: "nftCollateralContract", type: "address" },
                    { internalType: "uint32", name: "loanDuration", type: "uint32" },
                    { internalType: "uint16", name: "loanAdminFeeInBasisPoints", type: "uint16" },
                    { internalType: "address", name: "loanERC20Denomination", type: "address" },
                    { internalType: "address", name: "referrer", type: "address" },
                ],
                internalType: "struct LoanData.Offer",
                name: "_offer",
                type: "tuple",
            },
            {
                components: [
                    { internalType: "uint256", name: "nonce", type: "uint256" },
                    { internalType: "uint256", name: "expiry", type: "uint256" },
                    { internalType: "address", name: "signer", type: "address" },
                    { internalType: "bytes", name: "signature", type: "bytes" },
                ],
                internalType: "struct LoanData.Signature",
                name: "_signature",
                type: "tuple",
            },
            {
                components: [
                    { internalType: "address", name: "revenueSharePartner", type: "address" },
                    { internalType: "uint16", name: "referralFeeInBasisPoints", type: "uint16" },
                ],
                internalType: "struct LoanData.BorrowerSettings",
                name: "_borrowerSettings",
                type: "tuple",
            },
        ],
        name: "acceptOffer",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "adminFeeInBasisPoints",
        outputs: [{ internalType: "uint16", name: "", type: "uint16" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_nonce", type: "uint256" }],
        name: "cancelLoanCommitmentBeforeLoanHasBegun",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_tokenAddress", type: "address" },
            { internalType: "uint256", name: "_tokenId", type: "uint256" },
            { internalType: "address", name: "_receiver", type: "address" },
        ],
        name: "drainERC1155Airdrop",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_tokenAddress", type: "address" },
            { internalType: "address", name: "_receiver", type: "address" },
        ],
        name: "drainERC20Airdrop",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_tokenAddress", type: "address" },
            { internalType: "uint256", name: "_tokenId", type: "uint256" },
            { internalType: "address", name: "_receiver", type: "address" },
        ],
        name: "drainERC721Airdrop",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "address", name: "_erc20", type: "address" }],
        name: "getERC20Permit",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint32", name: "_loanId", type: "uint32" }],
        name: "getPayoffAmount",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_user", type: "address" },
            { internalType: "uint256", name: "_nonce", type: "uint256" },
        ],
        name: "getWhetherNonceHasBeenUsedForUser",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "hub",
        outputs: [{ internalType: "contract INftfiHub", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint32", name: "_loanId", type: "uint32" }],
        name: "liquidateOverdueLoan",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint32", name: "", type: "uint32" }],
        name: "loanIdToLoan",
        outputs: [
            { internalType: "uint256", name: "loanPrincipalAmount", type: "uint256" },
            { internalType: "uint256", name: "maximumRepaymentAmount", type: "uint256" },
            { internalType: "uint256", name: "nftCollateralId", type: "uint256" },
            { internalType: "address", name: "loanERC20Denomination", type: "address" },
            { internalType: "uint32", name: "loanDuration", type: "uint32" },
            { internalType: "uint16", name: "loanInterestRateForDurationInBasisPoints", type: "uint16" },
            { internalType: "uint16", name: "loanAdminFeeInBasisPoints", type: "uint16" },
            { internalType: "address", name: "nftCollateralWrapper", type: "address" },
            { internalType: "uint64", name: "loanStartTime", type: "uint64" },
            { internalType: "address", name: "nftCollateralContract", type: "address" },
            { internalType: "address", name: "borrower", type: "address" },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint32", name: "", type: "uint32" }],
        name: "loanIdToLoanExtras",
        outputs: [
            { internalType: "address", name: "revenueSharePartner", type: "address" },
            { internalType: "uint16", name: "revenueShareInBasisPoints", type: "uint16" },
            { internalType: "uint16", name: "referralFeeInBasisPoints", type: "uint16" },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint32", name: "", type: "uint32" }],
        name: "loanRepaidOrLiquidated",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "maximumLoanDuration",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint32", name: "_loanId", type: "uint32" }],
        name: "mintObligationReceipt",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "", type: "address" },
            { internalType: "address", name: "", type: "address" },
            { internalType: "uint256[]", name: "", type: "uint256[]" },
            { internalType: "uint256[]", name: "", type: "uint256[]" },
            { internalType: "bytes", name: "", type: "bytes" },
        ],
        name: "onERC1155BatchReceived",
        outputs: [{ internalType: "bytes4", name: "", type: "bytes4" }],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "", type: "address" },
            { internalType: "address", name: "", type: "address" },
            { internalType: "uint256", name: "", type: "uint256" },
            { internalType: "uint256", name: "", type: "uint256" },
            { internalType: "bytes", name: "", type: "bytes" },
        ],
        name: "onERC1155Received",
        outputs: [{ internalType: "bytes4", name: "", type: "bytes4" }],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "", type: "address" },
            { internalType: "address", name: "", type: "address" },
            { internalType: "uint256", name: "", type: "uint256" },
            { internalType: "bytes", name: "", type: "bytes" },
        ],
        name: "onERC721Received",
        outputs: [{ internalType: "bytes4", name: "", type: "bytes4" }],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "owner",
        outputs: [{ internalType: "address", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
    },
    { inputs: [], name: "pause", outputs: [], stateMutability: "nonpayable", type: "function" },
    {
        inputs: [],
        name: "paused",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint32", name: "_loanId", type: "uint32" }],
        name: "payBackLoan",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "uint32", name: "_loanId", type: "uint32" },
            { internalType: "address", name: "_target", type: "address" },
            { internalType: "bytes", name: "_data", type: "bytes" },
            { internalType: "address", name: "_nftAirdrop", type: "address" },
            { internalType: "uint256", name: "_nftAirdropId", type: "uint256" },
            { internalType: "bool", name: "_is1155", type: "bool" },
            { internalType: "uint256", name: "_nftAirdropAmount", type: "uint256" },
        ],
        name: "pullAirdrop",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "uint32", name: "_loanId", type: "uint32" },
            { internalType: "uint32", name: "_newLoanDuration", type: "uint32" },
            { internalType: "uint256", name: "_newMaximumRepaymentAmount", type: "uint256" },
            { internalType: "uint256", name: "_renegotiationFee", type: "uint256" },
            { internalType: "uint256", name: "_lenderNonce", type: "uint256" },
            { internalType: "uint256", name: "_expiry", type: "uint256" },
            { internalType: "bytes", name: "_lenderSignature", type: "bytes" },
        ],
        name: "renegotiateLoan",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_erc20", type: "address" },
            { internalType: "bool", name: "_permit", type: "bool" },
        ],
        name: "setERC20Permit",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address[]", name: "_erc20s", type: "address[]" },
            { internalType: "bool[]", name: "_permits", type: "bool[]" },
        ],
        name: "setERC20Permits",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "bytes4", name: "_interfaceId", type: "bytes4" }],
        name: "supportsInterface",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "address", name: "_newOwner", type: "address" }],
        name: "transferOwnership",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    { inputs: [], name: "unpause", outputs: [], stateMutability: "nonpayable", type: "function" },
    {
        inputs: [{ internalType: "uint16", name: "_newAdminFeeInBasisPoints", type: "uint16" }],
        name: "updateAdminFee",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_newMaximumLoanDuration", type: "uint256" }],
        name: "updateMaximumLoanDuration",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint32", name: "_loanId", type: "uint32" }],
        name: "wrapCollateral",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
];
export const NFTFI_OBLIGATION_RECEIPT_TOKEN_ABI = [
    {
        inputs: [
            { internalType: "address", name: "_admin", type: "address" },
            { internalType: "address", name: "_nftfiHub", type: "address" },
            { internalType: "address", name: "_loanCoordinator", type: "address" },
            { internalType: "string", name: "_name", type: "string" },
            { internalType: "string", name: "_symbol", type: "string" },
            { internalType: "string", name: "_customBaseURI", type: "string" },
        ],
        stateMutability: "nonpayable",
        type: "constructor",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "address", name: "owner", type: "address" },
            { indexed: true, internalType: "address", name: "approved", type: "address" },
            { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
        ],
        name: "Approval",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "address", name: "owner", type: "address" },
            { indexed: true, internalType: "address", name: "operator", type: "address" },
            { indexed: false, internalType: "bool", name: "approved", type: "bool" },
        ],
        name: "ApprovalForAll",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "bytes32", name: "role", type: "bytes32" },
            { indexed: true, internalType: "bytes32", name: "previousAdminRole", type: "bytes32" },
            { indexed: true, internalType: "bytes32", name: "newAdminRole", type: "bytes32" },
        ],
        name: "RoleAdminChanged",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "bytes32", name: "role", type: "bytes32" },
            { indexed: true, internalType: "address", name: "account", type: "address" },
            { indexed: true, internalType: "address", name: "sender", type: "address" },
        ],
        name: "RoleGranted",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "bytes32", name: "role", type: "bytes32" },
            { indexed: true, internalType: "address", name: "account", type: "address" },
            { indexed: true, internalType: "address", name: "sender", type: "address" },
        ],
        name: "RoleRevoked",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: "address", name: "from", type: "address" },
            { indexed: true, internalType: "address", name: "to", type: "address" },
            { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
        ],
        name: "Transfer",
        type: "event",
    },
    {
        inputs: [],
        name: "BASE_URI_ROLE",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "DEFAULT_ADMIN_ROLE",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "LOAN_COORDINATOR_ROLE",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "to", type: "address" },
            { internalType: "uint256", name: "tokenId", type: "uint256" },
        ],
        name: "approve",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "address", name: "owner", type: "address" }],
        name: "balanceOf",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "baseURI",
        outputs: [{ internalType: "string", name: "", type: "string" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
        name: "burn",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
        name: "exists",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
        name: "getApproved",
        outputs: [{ internalType: "address", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "bytes32", name: "role", type: "bytes32" }],
        name: "getRoleAdmin",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "bytes32", name: "role", type: "bytes32" },
            { internalType: "address", name: "account", type: "address" },
        ],
        name: "grantRole",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "bytes32", name: "role", type: "bytes32" },
            { internalType: "address", name: "account", type: "address" },
        ],
        name: "hasRole",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "hub",
        outputs: [{ internalType: "contract INftfiHub", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "owner", type: "address" },
            { internalType: "address", name: "operator", type: "address" },
        ],
        name: "isApprovedForAll",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        name: "loans",
        outputs: [
            { internalType: "address", name: "loanCoordinator", type: "address" },
            { internalType: "uint256", name: "loanId", type: "uint256" },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_to", type: "address" },
            { internalType: "uint256", name: "_tokenId", type: "uint256" },
            { internalType: "bytes", name: "_data", type: "bytes" },
        ],
        name: "mint",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "name",
        outputs: [{ internalType: "string", name: "", type: "string" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
        name: "ownerOf",
        outputs: [{ internalType: "address", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "bytes32", name: "role", type: "bytes32" },
            { internalType: "address", name: "account", type: "address" },
        ],
        name: "renounceRole",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "bytes32", name: "role", type: "bytes32" },
            { internalType: "address", name: "account", type: "address" },
        ],
        name: "revokeRole",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "from", type: "address" },
            { internalType: "address", name: "to", type: "address" },
            { internalType: "uint256", name: "tokenId", type: "uint256" },
        ],
        name: "safeTransferFrom",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "from", type: "address" },
            { internalType: "address", name: "to", type: "address" },
            { internalType: "uint256", name: "tokenId", type: "uint256" },
            { internalType: "bytes", name: "_data", type: "bytes" },
        ],
        name: "safeTransferFrom",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "operator", type: "address" },
            { internalType: "bool", name: "approved", type: "bool" },
        ],
        name: "setApprovalForAll",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "string", name: "_customBaseURI", type: "string" }],
        name: "setBaseURI",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "address", name: "_account", type: "address" }],
        name: "setLoanCoordinator",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "bytes4", name: "_interfaceId", type: "bytes4" }],
        name: "supportsInterface",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "symbol",
        outputs: [{ internalType: "string", name: "", type: "string" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
        name: "tokenURI",
        outputs: [{ internalType: "string", name: "", type: "string" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "from", type: "address" },
            { internalType: "address", name: "to", type: "address" },
            { internalType: "uint256", name: "tokenId", type: "uint256" },
        ],
        name: "transferFrom",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
];
