import "@typechain/hardhat";
import "@nomiclabs/hardhat-waffle";
import "hardhat-gas-reporter";
import "solidity-coverage";
import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-etherscan";
import "hardhat-contract-sizer";

import "./tasks/accounts";
import "./tasks/clean";

import { resolve } from "path";

import { config as dotenvConfig } from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import { NetworkUserConfig, HardhatNetworkUserConfig } from "hardhat/types";

dotenvConfig({ path: resolve(__dirname, "./.env") });

const chainIds = {
    ganache: 1337,
    goerli: 5,
    hardhat: 1337,
    localhost: 31337,
    kovan: 42,
    mainnet: 1,
    rinkeby: 4,
    ropsten: 3,
    sepolia: 11155111,
};

// Ensure that we have all the environment variables we need.
let mnemonic: string;
if (!process.env.MNEMONIC) {
    mnemonic = "test test test test test test test test test test test junk";
} else {
    mnemonic = process.env.MNEMONIC;
}

const forkMainnet = process.env.FORK_MAINNET === "true";

let alchemyApiKey: string | undefined;
if (forkMainnet && !process.env.ALCHEMY_API_KEY) {
    throw new Error("Please set process.env.ALCHEMY_API_KEY");
} else {
    alchemyApiKey = process.env.ALCHEMY_API_KEY;
}

// create testnet network
function createTestnetConfig(network: keyof typeof chainIds): NetworkUserConfig {
    const sepoliaUri = `https://rpc.sepolia.org/`;
    const defaultUri = `https://eth-${network}.alchemyapi.io/v2/${alchemyApiKey}`;
    const url = network === `sepolia` ? sepoliaUri : defaultUri;

    return {
        accounts: {
            count: 10,
            initialIndex: 0,
            mnemonic,
            path: "m/44'/60'/0'/0", // HD derivation path
        },
        chainId: chainIds[network],
        url,
    };
}

// create local network config
function createHardhatConfig(): HardhatNetworkUserConfig {
    const config = {
        accounts: {
            mnemonic,
        },
        allowUnlimitedContractSize: true,
        chainId: chainIds.hardhat,
        contractSizer: {
            alphaSort: true,
            disambiguatePaths: false,
            runOnCompile: true,
            strict: true,
            only: [":ERC20$"],
        },
    };

    if (forkMainnet) {
        return Object.assign(config, {
            forking: {
                url: `https://eth-mainnet.alchemyapi.io/v2/${alchemyApiKey}`,
                blockNumber: 17895128,
            },
        });
    }

    return config;
}

function createMainnetConfig(): NetworkUserConfig {
    return {
        accounts: {
            mnemonic,
        },
        chainId: chainIds.mainnet,
        url: `https://eth-mainnet.alchemyapi.io/v2/${alchemyApiKey}`,
    };
}

const optimizerEnabled = process.env.DISABLE_OPTIMIZER ? false : true;

export const config: HardhatUserConfig = {
    defaultNetwork: "hardhat",
    gasReporter: {
        currency: "USD",
        enabled: process.env.REPORT_GAS ? true : false,
        excludeContracts: [],
        src: "./contracts",
        coinmarketcap: process.env.COINMARKETCAP_API_KEY,
        outputFile: process.env.REPORT_GAS_OUTPUT,
    },
    networks: {
        mainnet: createMainnetConfig(),
        hardhat: createHardhatConfig(),
        goerli: createTestnetConfig("goerli"),
        kovan: createTestnetConfig("kovan"),
        rinkeby: createTestnetConfig("rinkeby"),
        ropsten: createTestnetConfig("ropsten"),
        sepolia: createTestnetConfig("sepolia"),
        localhost: {
            accounts: {
                mnemonic,
            },
            chainId: chainIds.hardhat,
            gasMultiplier: 10,
        },
    },
    paths: {
        artifacts: "./artifacts",
        cache: "./cache",
        sources: "./contracts",
        tests: "./test",
    },
    solidity: {
        compilers: [
            {
                version: "0.8.18",
                settings: {
                    metadata: {
                        // Not including the metadata hash
                        // https://github.com/paulrberg/solidity-template/issues/31
                        bytecodeHash: "none",
                    },
                    // You should disable the optimizer when debugging
                    // https://hardhat.org/hardhat-network/#solidity-optimizer-support
                    optimizer: {
                        enabled: optimizerEnabled,
                        runs: 200,
                    },
                },
            },
            {
                version: "0.7.0",
            },
            {
                version: "0.4.12",
            },
            {
                version: "0.4.18",
            },
        ],
    },
    typechain: {
        outDir: "typechain",
        target: "ethers-v5",
    },
    etherscan: {
        apiKey: process.env.ETHERSCAN_API_KEY,
    },
    mocha: {
        timeout: 100000,
    },
};

export default config;
