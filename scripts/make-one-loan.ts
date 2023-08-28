import { ethers } from "hardhat";
import { random } from "lodash";

import { loadContracts, DeployedResources } from "./utils/deploy";
import { SECTION_SEPARATOR } from "./utils/constants";
import { LoanTerms } from "../test/utils/types";
import { createLoanTermsSignature } from "../test/utils/eip712";

import { createVault } from "./utils/vault";

import { MockERC721Metadata } from "../typechain";

export async function makeLoan(resources: DeployedResources): Promise<void> {
    const signers = await ethers.getSigners();
    const [, admin, borrower, lender] = signers;

    const WETH = "0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6" // gweth
    const NONCE = 1;

    const {
        originationController,
        vaultFactory,
        loanCore
    } = resources;

    console.log("Balances:");
    console.log("Borrower:", ethers.utils.formatEther(await borrower.getBalance()));
    console.log("Lender:", ethers.utils.formatEther(await lender.getBalance()));

    console.log(SECTION_SEPARATOR);

    console.log("Vaulting assets...");

    const erc721Factory = await ethers.getContractFactory("MockERC721Metadata");
    const punks = <MockERC721Metadata>await erc721Factory.deploy("PawnFiPunks", "PFPUNKS");
    const weth = await ethers.getContractAt("IERC20", WETH);

    await originationController.connect(admin).setAllowedPayableCurrencies(
        [weth.address],
        [{ isAllowed: true, minPrincipal: ethers.utils.parseEther("0.001") }]
    );

    await originationController.connect(admin).setAllowedCollateralAddresses(
        [vaultFactory.address], [true]
    );

    await punks["mint(address,string)"](
        borrower.address,
        `https://s3.amazonaws.com/images.pawn.fi/test-nft-metadata/PawnFiPunks/nft-42.json`,
    );

    const vault = await createVault(vaultFactory, borrower);

    const tokenId = await punks.tokenOfOwnerByIndex(borrower.address, 0);
    await punks.connect(borrower)["safeTransferFrom(address,address,uint256)"](borrower.address, vault.address, tokenId);

    console.log("Signing terms...");

    const oneDayMs = 1000 * 60 * 60 * 24;
    const oneWeekMs = oneDayMs * 7;
    const relSecondsFromMs = (msToAdd: number) => Math.floor(msToAdd / 1000);

    const amount = random(100, 200) / 1000;
    const amountBase = ethers.utils.parseEther(amount.toString());

    const terms: LoanTerms = {
        durationSecs: relSecondsFromMs(oneWeekMs),
        principal: amountBase,
        proratedInterestRate: ethers.utils.parseEther("1.5"),
        collateralAddress: vaultFactory.address,
        collateralId: vault.address,
        payableCurrency: weth.address,
        deadline: 1754884800,
        affiliateCode: ethers.constants.HashZero
    };

    const sig = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        terms,
        borrower,
        "3",
        NONCE,
        "b",
    );

    console.log("Approving...");

    await weth.connect(lender).approve(loanCore.address, amountBase);
    await vaultFactory.connect(borrower).approve(loanCore.address, vault.address);

    console.log("Making loan...");

    // Borrower signed, so lender will initialize
    // const call = await originationController.interface
    //     .encodeFunctionData("initializeLoan", [
    //         terms,
    //         borrower.address,
    //         lender.address,
    //         sig,
    //         NONCE
    //     ]);

    await originationController
            .connect(lender)
            .initializeLoan(
                terms,
                borrower.address,
                lender.address,
                sig,
                NONCE
            );

    console.log(
        `(Loan 1) Signer ${borrower.address} borrowed ${amount} WETH at 15% interest from ${lender.address} against Vault ${vault.address}`
    );
}

if (require.main === module) {
    // retrieve command line args array
    const file = process.env.DEPLOYMENT_FILE;

    console.log("File:", file);

    // assemble args to access the relevant deplyment json in .deployment
    void loadContracts(file!)
        .then(makeLoan)
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}