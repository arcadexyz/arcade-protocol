import chai, { expect } from "chai";
import { waffle, ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumber } from "ethers";
import { deploy } from "./utils/contracts";
import { Contract } from "ethers";

chai.use(solidity);

import {
    OriginationHelpers,
    OriginationControllerCurrencyMigrate,
    MockERC20,
    LoanCore,
    FeeController,
    PromissoryNote,
    BaseURIDescriptor,
    WETH9,
    UniswapV3Factory,
    SwapRouter
} from "../typechain";

import { approve, mint, ZERO_ADDRESS } from "./utils/erc20";
import { mint as mint721 } from "./utils/erc721";
import { Borrower, ItemsPredicate, LoanTerms, SignatureItem, SignatureProperties } from "./utils/types";
import { createLoanTermsSignature, createLoanItemsSignature } from "./utils/eip712";
import { encodeSignatureItems, encodeItemCheck, initializeBundle } from "./utils/loans";

import { ORIGINATOR_ROLE, BASE_URI, MIN_LOAN_PRINCIPAL } from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    feeController: FeeController;
    lenderPromissoryNote: PromissoryNote;
    borrowerPromissoryNote: PromissoryNote;
    loanCore: LoanCore;
    originationHelpers: OriginationHelpers;
    originationControllerCurrencyMigrate: OriginationControllerCurrencyMigrate;
    user: Signer;
    other: Signer;
    other2: Signer;
    other3: Signer;
    signers: Signer[];
    mockDAI: MockERC20;
    mockUSDC: MockERC20;
    weth: WETH9;
    uniswapV3Factory: UniswapV3Factory;
    swapRouter: SwapRouter;
}

// to run: yarn test test/OriginationControllerCurrencyMigrate.ts

const fixture = async (): Promise<TestContext> => {
    const signers: Signer[] = await ethers.getSigners();
    const [deployer] = signers;

    const mockDAI = <MockERC20>await deploy("MockERC20", deployer, ["Mock Dai", "MOCK_DAI"]);
    const mockUSDC = <MockERC20>await deploy("MockERC20", deployer, ["Mock USDC", "MOCK_USDC"]);

    // deploy WETH
    const WETHFactory = await ethers.getContractFactory("WETH9");
    const weth = (await WETHFactory.deploy()) as WETH9;
    await weth.deployed();

    // deploy Uniswap V3 Factory
    const UniswapV3Factory = await ethers.getContractFactory("UniswapV3Factory");
    const uniswapV3Factory = (await UniswapV3Factory.deploy()) as UniswapV3Factory;
    await uniswapV3Factory.deployed();

    // Deploy the SwapRouter
    const SwapRouterFactory = await ethers.getContractFactory("SwapRouter");
    const swapRouter = (await SwapRouterFactory.deploy(uniswapV3Factory.address, weth.address)) as SwapRouter;
    await swapRouter.deployed();

    const feeController = <FeeController>await deploy("FeeController", signers[0], []);
    const descriptor = <BaseURIDescriptor>await deploy("BaseURIDescriptor", signers[0], [BASE_URI]);

    const borrowerNote = <PromissoryNote>(
        await deploy("PromissoryNote", deployer, ["Arcade.xyz BorrowerNote", "aBN", descriptor.address])
    );
    const lenderNote = <PromissoryNote>(
        await deploy("PromissoryNote", deployer, ["Arcade.xyz LenderNote", "aLN", descriptor.address])
    );

    const loanCore = <LoanCore>await deploy("LoanCore", signers[0], [borrowerNote.address, lenderNote.address]);

    // Grant correct permissions for promissory note
    for (const note of [borrowerNote, lenderNote]) {
        await note.connect(deployer).initialize(loanCore.address);
    }

    const originationHelpers = <OriginationHelpers>await deploy("OriginationHelpers", deployer, []);

    const originationLibrary = await deploy("OriginationLibrary", deployer, []);
    await originationLibrary.deployed();

    const OriginationControllerCurrencyMigrateFactory = await ethers.getContractFactory(
        "OriginationControllerCurrencyMigrate",
        {
            signer: signers[0],
            libraries: {
                OriginationLibrary: originationLibrary.address,
            },
        },
    );

    const originationControllerCurrencyMigrate = <OriginationControllerCurrencyMigrate>(
        await OriginationControllerCurrencyMigrateFactory.deploy(
            originationHelpers.address,
            loanCore.address,
            feeController.address,
            swapRouter.address,
        )
    );
    await originationControllerCurrencyMigrate.deployed();

    console.log("OriginationControllerCurrencyMigrate deployed to:", originationControllerCurrencyMigrate.address);

    // admin whitelists MockERC20 on OriginationController
    const whitelistCurrency = await originationHelpers.setAllowedPayableCurrencies(
        [mockDAI.address, mockUSDC.address],
        [
            { isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL },
            { isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL },
        ],
    );
    await whitelistCurrency.wait();
    // verify the currency is whitelisted
    const isWhitelistedDAI = await originationHelpers.isAllowedCurrency(mockDAI.address);
    expect(isWhitelistedDAI).to.be.true;
    const isWhitelistedWETH = await originationHelpers.isAllowedCurrency(mockUSDC.address);
    expect(isWhitelistedWETH).to.be.true;

    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationControllerCurrencyMigrate.address,
    );
    await updateOriginationControllerPermissions.wait();

    return {
        uniswapV3Factory,
        swapRouter,
        weth,
        feeController,
        originationHelpers,
        originationControllerCurrencyMigrate,
        lenderPromissoryNote: lenderNote,
        borrowerPromissoryNote: borrowerNote,
        loanCore,
        mockDAI,
        mockUSDC,
        user: deployer,
        other: signers[1],
        other2: signers[2],
        other3: signers[3],
        signers: signers.slice(2),
    };
};;

describe("OriginationControllerCurrencyMigrate", function () {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await loadFixture(fixture);
    });


    it("should swap DAI for WETH using Uniswap V3", async () => {
        const {
            originationControllerCurrencyMigrate,
            uniswapV3Factory,
            mockUSDC,
            mockDAI,
            weth,
            other: borrower,
            other2: depositorDAI,
            other3: depositorWETH,
        } = ctx;

        const amountIn = ethers.utils.parseUnits("100", 18); // 100 DAI

        await mint(mockDAI, borrower, amountIn); // mint DAI to borrower
        await mint(mockDAI, depositorDAI, amountIn.mul(10)); // mint DAI to pool depositor

        // fund pool depositor with WETH
        const depositAmount = ethers.utils.parseEther("1.0");
        const fundWETH = await weth.connect(depositorWETH).deposit({ value: depositAmount });
        await fundWETH.wait();

        // check WETH balance
        const wethBalance = await weth.balanceOf(depositorWETH.address);
        console.log(`WETH Balance: ${ethers.utils.formatEther(wethBalance)} WETH`);

        // borrower approves migration contract to spend DAI
        await mockDAI.connect(borrower).approve(originationControllerCurrencyMigrate.address, amountIn);

        // get user's initial WETH balance
        const initialERC20Balance = await mockUSDC.balanceOf(await borrower.getAddress());
        console.log("initialERC20Balance", initialERC20Balance.toString());
        // Call swapExactInputSingle
        const amountOutMinimum = 0; // Set this according to your test requirements
        const fee = 3000; // pool fee, which is 0.3%

        const tokenA = mockDAI.address;
        const tokenB = weth.address;

        // create the mock DAI/USDC pool
        const tx = await uniswapV3Factory.createPool(tokenA, tokenB, fee);
        const receipt = await tx.wait();
        const poolAddress = receipt.logs[0].address;
        console.log("poolAddress", poolAddress);

        // attach to the pool contract
        const poolContract = await ethers.getContractAt("UniswapV3Pool", poolAddress);

        // Set the square root price x96 to be 1 << 96 for a 1:1 price ratio
        const sqrtPriceX96 = ethers.BigNumber.from("1").shl(96); // `shl` is shift left, equivalent to multiplying by 2^96

        // Initialize the pool
    try {
        const initTx = await poolContract.initialize(sqrtPriceX96);
        await initTx.wait();
        console.log("Pool initialized with sqrtPriceX96:", sqrtPriceX96.toString());
    } catch (error) {
        console.error("Initialization failed:", error);
    }

        console.log("sqrtRatio", sqrtPriceX96);
        // approve the pool to spend tokens for depositors
        await mockDAI.connect(depositorDAI).approve(poolContract.address, ethers.utils.parseEther("1000"));
        await weth.connect(depositorWETH).approve(poolContract.address, depositAmount.mul(10));
        console.log("approved --------------------");
        // amounts to be deposited
        const amountDAI = ethers.utils.parseEther("1000"); // 1000 DAI
        const amountWETH = ethers.utils.parseEther("10"); // 10 WETH

        // add liquidity to the pool
        const addLiquidityTx = await poolContract.connect(depositorDAI).addLiquidity({
            token0: mockDAI.address,
            token1: weth.address,
            fee: fee,
            recipient: depositorDAI.address,
            tickLower: -887220, // Example tick range, needs calculation based on desired prices
            tickUpper: 887220, // Example tick range, needs calculation based on desired prices
            amount0Desired: amountDAI,
            amount1Desired: amountWETH,
            amount0Min: 0, // Minimum amounts should be set based on slippage tolerance
            amount1Min: 0,
            deadline: Math.floor(Date.now() / 1000) + 3600, // Deadline in seconds from now
        });
        await addLiquidityTx.wait();

        // call swapExactInputSingle
        await originationControllerCurrencyMigrate
            .connect(borrower)
            .swapExactInputSingle(
                mockDAI.address,
                weth.address,
                amountIn,
                amountOutMinimum,
                fee,
                originationControllerCurrencyMigrate.address,
            );

        // get user's WETH balance after swap
        const newWETHBalance = await mockUSDC.balanceOf(await borrower.getAddress());

        // WETH balance has increased
        expect(newWETHBalance).to.be.gt(initialERC20Balance);
    });
});
