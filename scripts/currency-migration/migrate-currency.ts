import hre, { ethers } from "hardhat";

import { Signer, Contract, BigNumber } from "ethers";
import { SECTION_SEPARATOR } from "../utils/constants";
import { main as deploy } from "../deploy/deploy";
import { doWhitelisting } from "../deploy/whitelisting";
import { setupRoles } from "../deploy/setup-roles";

import {
    OriginationLibrary,
    ERC20
} from "../../typechain";

// UniswapV3 contract addresses
const uniswapV3FactoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // UniswapV3 Factory address on mainnet
const swapRouterAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // UniswapV3 Swap Router address on mainnet

// currencies to swap
const DAIAddress = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // Mainnet DAI address
const WETHAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // Mainnet WETH address

// actors
const DAI_WHALE = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const WETH_WHALE = "0x"
const BORROWER = "0x434890980a2392C12dF4Ed728Cacd3a3261678EF";
const DEPLOYER = "0x6c6F915B21d43107d83c47541e5D29e872d82Da6";

/**
 * To run:
 * `FORK_MAINNET=true npx hardhat run scripts/currency-migration/migrate-currency.ts`
 */

export async function main(): Promise<void> {
    const resources = await deploy();
    console.log("V4 contracts deployed!");

    await doWhitelisting(resources);
    console.log("V4 whitelisting complete!");

    await setupRoles(resources);
    console.log("V4 contracts setup!");

    console.log(SECTION_SEPARATOR);

    const { loanCore, feeController, originationHelpers } = resources;

    const erc20Factory = await ethers.getContractFactory("ERC20");
    const currencyIn = <ERC20>erc20Factory.attach(DAIAddress);
    const currencyOut = <ERC20>erc20Factory.attach(WETHAddress);

    const OriginationLibraryFactory = await ethers.getContractFactory("OriginationLibrary");
    const originationLibrary = <OriginationLibrary>await OriginationLibraryFactory.deploy();

    // deploy the currency migration contract
    const OriginationControllerCurrencyMigrateFactory = await ethers.getContractFactory(
        "OriginationControllerCurrencyMigrate",
        {
            libraries: {
                OriginationLibrary: originationLibrary.address,
            },
        },
    );

    const originationControllerCurrencyMigrate = await OriginationControllerCurrencyMigrateFactory.deploy(
        originationHelpers.address,
        loanCore.address,
        feeController.address,
        swapRouterAddress,
    );
    await originationControllerCurrencyMigrate.deployed();

    console.log("OriginationControllerCurrencyMigrate address: ", originationControllerCurrencyMigrate.address);
    console.log(SECTION_SEPARATOR);

    // main actors
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [BORROWER],
    });
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [DAI_WHALE],
    });

    console.log(SECTION_SEPARATOR);

    const whale = await ethers.getSigner(DAI_WHALE);
    const borrower = await ethers.getSigner(BORROWER);
    console.log("Borrower who will perform the swap: ", borrower.address);

    await whale.sendTransaction({ to: borrower.address, value: ethers.utils.parseEther(".5") });

    // amount to swap
    const amountIn = ethers.utils.parseEther("100"); // 100 DAI
    // TODO: explain about fee
    const fee = 3000; // pool fee, which is 0.3%

    await currencyIn.connect(whale).transfer(borrower.address, amountIn);
    await currencyIn.connect(borrower).approve(originationControllerCurrencyMigrate.address, amountIn);

    console.log("Borrower DAI balance: ", ethers.utils.formatEther(await currencyIn.balanceOf(borrower.address)));

    // make the swap
    await originationControllerCurrencyMigrate
        .connect(borrower)
        .swapExactInputSingle(DAIAddress, WETHAddress, amountIn, 0, fee, originationControllerCurrencyMigrate.address);

    console.log(
        "CurrencyMigrate contract WETH balance: ",
        ethers.utils.formatEther(await currencyOut.balanceOf(originationControllerCurrencyMigrate.address)),
    );
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}

