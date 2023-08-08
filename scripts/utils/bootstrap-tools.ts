import { ethers } from "hardhat";
import { Contract, BigNumber } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { LoanTerms } from "../../test/utils/types";
import { createLoanTermsSignature } from "../../test/utils/eip712";
import { main as setupRoles } from "../deploy/setup-roles";

import { MockERC1155Metadata, MockERC20, MockERC721Metadata, VaultFactory } from "../../typechain";
import { createVault } from "./vault";

export const SECTION_SEPARATOR = "\n" + "=".repeat(80) + "\n";
export const SUBSECTION_SEPARATOR = "-".repeat(10);

export async function vaultAssetsAndMakeLoans(
    signers: SignerWithAddress[],
    factory: VaultFactory,
    originationController: Contract,
    borrowerNote: Contract,
    repaymentController: Contract,
    lenderNote: Contract,
    loanCore: Contract,
    feeController: Contract,
    whitelist: Contract,
    verifier: Contract,
    punks: MockERC721Metadata,
    usd: MockERC20,
    beats: MockERC1155Metadata,
    weth: MockERC20,
    art: MockERC721Metadata,
    pawnToken: MockERC20,
): Promise<void> {
    console.log(SECTION_SEPARATOR);
    console.log("But let's set up roles and permissions first...\n");
    // setup the role privileges
    await setupRoles(
        factory,
        originationController,
        borrowerNote,
        repaymentController,
        lenderNote,
        loanCore,
        feeController,
        whitelist,
        verifier,
    );

    // Connect the first signer with the
    const signer1 = signers[1];
    const signer1Address = await signers[1].getAddress();
    // Create vault 1
    const av1A = await createVault(factory, signer1); // this is the Vault Id
    // Deposit 1 punk and 1000 usd to user's first vault:
    // First get signer1 punks to deposit into vault 1
    const av1Punk1Id = await punks.tokenOfOwnerByIndex(signer1Address, 0);

    await punks.connect(signer1).approve(av1A.address, av1Punk1Id);
    await punks.connect(signer1).transferFrom(signer1Address, av1A.address, av1Punk1Id.toNumber());

    // Next get signer1 1000 usd to vault 1
    await usd.connect(signer1).approve(av1A.address, ethers.utils.parseUnits("1000", 6));
    await usd.connect(signer1).transfer(av1A.address, ethers.utils.parseUnits("1000", 6));
    console.log(`(Vault 1A) Signer ${signer1.address} created a vault with 1 PawnFiPunk and 1000 PUSD`);

    // Deposit 1 punk and 2 beats edition 0 for bundle 2
    // Create vault 2
    const av1B = await createVault(factory, signer1);
    const av2Punk2Id = await punks.tokenOfOwnerByIndex(signer1Address, 1);

    await punks.connect(signer1).approve(av1B.address, av2Punk2Id.toNumber());
    await punks.connect(signer1).transferFrom(signer1Address, av1B.address, av2Punk2Id.toNumber());
    await beats.connect(signer1).setApprovalForAll(av1B.address, true);
    await beats.connect(signer1).safeBatchTransferFrom(signer1Address, av1B.address, [0, 1], [2, 1], "0x00"); //
    console.log(`(Vault 1B) Signer ${signer1.address} created a vault with 1 PawnFiPunk and 2 PawnBeats Edition 0`);

    // Connect the third signer
    const signer3 = signers[3];
    const signer3Address = await signers[3].getAddress();

    // Create vault 3A
    const av3A = await createVault(factory, signer3);

    // Deposit 2 punks and 1 weth for vault 3A
    const av3Punk1Id = await punks.tokenOfOwnerByIndex(signer3Address, 0);
    const av3Punk2Id = await punks.tokenOfOwnerByIndex(signer3Address, 1);

    await punks.connect(signer3).approve(av3A.address, av3Punk1Id);
    await punks.connect(signer3).approve(av3A.address, av3Punk2Id);
    await punks.connect(signer3).transferFrom(signer3Address, av3A.address, av3Punk1Id.toNumber());
    await punks.connect(signer3).transferFrom(signer3Address, av3A.address, av3Punk2Id.toNumber());

    await weth.connect(signer3).approve(av3A.address, ethers.utils.parseUnits("1"));
    await weth.connect(signer3).transfer(av3A.address, ethers.utils.parseUnits("1"));
    console.log(`(Vault 3A) Signer ${signer3.address} created a vault with 2 PawnFiPunks and 1 WETH`);

    // Deposit 1 punk for user's second vault
    // Create vault 3B
    const av3B = await createVault(factory, signer3);
    const av3Punk3Id = await punks.tokenOfOwnerByIndex(signer3Address, 2);

    await punks.connect(signer3).approve(av3B.address, av3Punk3Id);
    await punks.connect(signer3).transferFrom(signer3Address, av3B.address, av3Punk3Id.toNumber());
    console.log(`(Vault 3B) Signer ${signer3.address} created a vault with 1 PawnFiPunk`);

    // Deposit 1 art, 4 beats edition 0, and 2000 usd for bundle 3
    // Create vault 3C
    const av3C = await createVault(factory, signer3);
    const av3Art1Id = await art.tokenOfOwnerByIndex(signer3Address, 0);

    await art.connect(signer3).approve(av3C.address, av3Art1Id);
    await art.connect(signer3).transferFrom(signer3Address, av3C.address, av3Art1Id.toNumber());
    await beats.connect(signer3).setApprovalForAll(av3C.address, true);
    await beats.connect(signer3).safeBatchTransferFrom(signer3Address, av3C.address, [0], [4], "0x00");
    await usd.connect(signer3).approve(av3C.address, ethers.utils.parseUnits("2000", 6));
    await usd.connect(signer3).transfer(av3C.address, ethers.utils.parseUnits("2000", 6));
    console.log(
        `(Vault 3C) Signer ${signer3.address} created a vault with 1 PawnArt, 4 PawnBeats Edition 0, and 2000 PUSD`,
    );
    // Connect the fourth signer
    const signer4 = signers[4];
    const signer4Address = await signers[4].getAddress();

    // Create vault 4A
    const av4A = await createVault(factory, signer4);
    // Deposit 3 arts and 1000 pawn for bundle 1
    const av4Art1Id = await art.tokenOfOwnerByIndex(signer4.address, 0);
    const av4Art2Id = await art.tokenOfOwnerByIndex(signer4.address, 1);
    const av4Art3Id = await art.tokenOfOwnerByIndex(signer4.address, 2);

    await art.connect(signer4).approve(av4A.address, av4Art1Id);
    await art.connect(signer4).approve(av4A.address, av4Art2Id);
    await art.connect(signer4).approve(av4A.address, av4Art3Id);

    await art.connect(signer4).transferFrom(signer4Address, av4A.address, av4Art1Id.toNumber());
    await art.connect(signer4).transferFrom(signer4Address, av4A.address, av4Art2Id.toNumber());
    await art.connect(signer4).transferFrom(signer4Address, av4A.address, av4Art3Id.toNumber());

    await pawnToken.connect(signer4).approve(av4A.address, ethers.utils.parseUnits("1000"));
    await pawnToken.connect(signer4).transfer(av4A.address, ethers.utils.parseUnits("1000"));
    console.log(`(Vault 4A) Signer ${signer4.address} created a vault with 4 PawnArts and 1000 PAWN`);

    // Deposit 1 punk and 1 beats edition 1 for bundle 2
    // Create vault 4B
    const av4B = await createVault(factory, signer4);

    const av4Punk1Id = await punks.tokenOfOwnerByIndex(signer4Address, 0);
    await punks.connect(signer4).approve(av4B.address, av4Punk1Id);
    await punks.connect(signer4).transferFrom(signer4Address, av4B.address, av4Punk1Id.toNumber());

    await beats.connect(signer4).setApprovalForAll(av4B.address, true);
    await beats.connect(signer4).safeBatchTransferFrom(signer4Address, av4B.address, [0, 1], [1, 6], "0x00");
    console.log(`(Vault 4B) Signer ${signer4.address} created a vault with 1 PawnFiPunk and 1 PawnBeats Edition 1`);

    console.log(SECTION_SEPARATOR);
    console.log("Initializing loans...\n");

    // Start some loans
    const signer2 = signers[2];
    const oneDayMs = 1000 * 60 * 60 * 24;
    const oneWeekMs = oneDayMs * 7;
    const oneMonthMs = oneDayMs * 30;

    const relSecondsFromMs = (msToAdd: number) => Math.floor(msToAdd / 1000);

    // 1 will borrow from 2
    const loan1Terms: LoanTerms = {
        durationSecs: relSecondsFromMs(oneWeekMs),
        principal: ethers.utils.parseEther("10"),
        proratedInterestRate: ethers.utils.parseEther("1.5"),
        collateralAddress: factory.address,
        collateralId: av1A.address,
        payableCurrency: weth.address,
        deadline: 1754884800,
        affiliateCode: "0x",
    };

    const sig = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        loan1Terms,
        signer1,
        "2",
        BigNumber.from(1),
        "b",
    );

    await weth.connect(signer2).approve(originationController.address, ethers.utils.parseEther("10"));
    await factory.connect(signer1).approve(originationController.address, av1A.address);

    // Borrower signed, so lender will initialize
    await originationController
        .connect(signer2)
        .initializeLoan(loan1Terms, signer1.address, signer2.address, sig, BigNumber.from(1));

    console.log(
        `(Loan 1) Signer ${signer1.address} borrowed 10 WETH at 15% interest from ${signer2.address} against Vault 1A`,
    );

    // 1 will borrow from 3
    const loan2Terms: LoanTerms = {
        durationSecs: relSecondsFromMs(oneWeekMs) - 10,
        principal: ethers.utils.parseEther("10000"),
        proratedInterestRate: ethers.utils.parseEther("0.5"),
        collateralAddress: factory.address,
        collateralId: av1B.address,
        payableCurrency: pawnToken.address,
        deadline: 1754884800,
        affiliateCode: "0x",
    };

    const sig2 = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        loan2Terms,
        signer1,
        "2",
        BigNumber.from(2),
        "b",
    );

    await pawnToken.connect(signer3).approve(originationController.address, ethers.utils.parseEther("10000"));
    await factory.connect(signer1).approve(originationController.address, av1B.address);

    // Borrower signed, so lender will initialize
    await originationController.connect(signer3).initializeLoan(loan2Terms, signer1.address, signer3.address, sig2, 2);

    console.log(
        `(Loan 2) Signer ${signer1.address} borrowed 10000 PAWN at 5% interest from ${signer3.address} against Vault 1B`,
    );

    // 3 will borrow from 2
    const loan3Terms: LoanTerms = {
        durationSecs: relSecondsFromMs(oneDayMs) - 10,
        principal: ethers.utils.parseUnits("1000", 6),
        proratedInterestRate: ethers.utils.parseUnits("80"),
        collateralAddress: factory.address,
        collateralId: av3A.address,
        payableCurrency: usd.address,
        deadline: 1754884800,
        affiliateCode: "0x",
    };

    const sig3 = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        loan3Terms,
        signer3,
        "2",
        BigNumber.from(1),
        "b",
    );

    await usd.connect(signer2).approve(originationController.address, ethers.utils.parseUnits("1000", 6));
    await factory.connect(signer3).approve(originationController.address, av3A.address);

    // Borrower signed, so lender will initialize
    await originationController.connect(signer2).initializeLoan(loan3Terms, signer3.address, signer2.address, sig3, 1);

    console.log(
        `(Loan 3) Signer ${signer3.address} borrowed 1000 PUSD at 8% interest from ${signer2.address} against Vault 3A`,
    );

    // 3 will open a second loan from 2
    const loan4Terms: LoanTerms = {
        durationSecs: relSecondsFromMs(oneMonthMs),
        principal: ethers.utils.parseUnits("1000", 6),
        proratedInterestRate: ethers.utils.parseUnits("140"),
        collateralAddress: factory.address,
        collateralId: av3B.address,
        payableCurrency: usd.address,
        deadline: 1754884800,
        affiliateCode: "0x",
    };

    const sig4 = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        loan4Terms,
        signer3,
        "2",
        BigNumber.from(2),
        "b",
    );

    await usd.connect(signer2).approve(originationController.address, ethers.utils.parseUnits("1000", 6));
    await factory.connect(signer3).approve(originationController.address, av3B.address);

    // Borrower signed, so lender will initialize
    await originationController.connect(signer2).initializeLoan(loan4Terms, signer3.address, signer2.address, sig4, 2);

    console.log(
        `(Loan 4) Signer ${signer3.address} borrowed 1000 PUSD at 14% interest from ${signer2.address} against Vault 3B`,
    );

    // 3 will also borrow from 4
    const loan5Terms: LoanTerms = {
        durationSecs: relSecondsFromMs(9000000),
        principal: ethers.utils.parseEther("20"),
        proratedInterestRate: ethers.utils.parseEther("2.0"),
        collateralAddress: factory.address,
        collateralId: av3C.address,
        payableCurrency: weth.address,
        deadline: 1754884800,
        affiliateCode: "0x",
    };

    const sig5 = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        loan5Terms,
        signer3,
        "2",
        BigNumber.from(3),
        "b",
    );

    await weth.connect(signer4).approve(originationController.address, ethers.utils.parseEther("20"));
    await factory.connect(signer3).approve(originationController.address, av3C.address);

    // Borrower signed, so lender will initialize
    await originationController.connect(signer4).initializeLoan(loan5Terms, signer3.address, signer4.address, sig5, 3);

    console.log(
        `(Loan 5) Signer ${signer3.address} borrowed 20 WETH at 2% interest from ${signer4.address} against Vault 3C`,
    );

    // 4 will borrow from 2
    const loan6Terms: LoanTerms = {
        durationSecs: relSecondsFromMs(oneWeekMs),
        principal: ethers.utils.parseEther("300.33"),
        proratedInterestRate: ethers.utils.parseEther("18.0198"),
        collateralAddress: factory.address,
        collateralId: av4A.address,
        payableCurrency: pawnToken.address,
        deadline: 1754884800,
        affiliateCode: "0x",
    };

    const sig6 = await createLoanTermsSignature(
        originationController.address,
        "OriginationController",
        loan6Terms,
        signer4,
        "2",
        BigNumber.from(1),
        "b",
    );

    await pawnToken.connect(signer2).approve(originationController.address, ethers.utils.parseEther("300.33"));
    await factory.connect(signer4).approve(originationController.address, av4A.address);

    // Borrower signed, so lender will initialize
    await originationController.connect(signer2).initializeLoan(loan6Terms, signer4.address, signer2.address, sig6, 1);

    console.log(
        `(Loan 6) Signer ${signer4.address} borrowed 300.33 PAWN at 6% interest from ${signer2.address} against Vault 4A`,
    );

    // Payoff a couple loans (not all)
    // Not setting up any claims because of timing issues.
    console.log(SECTION_SEPARATOR);
    console.log("Repaying (some) loans...\n");

    // 1 will pay off loan from 3
    const loan1BorrowerNoteId = await borrowerNote.tokenOfOwnerByIndex(signer1.address, 1);
    await pawnToken.connect(signer1).approve(repaymentController.address, ethers.utils.parseEther("10500"));
    await repaymentController.connect(signer1).repay(loan1BorrowerNoteId);

    console.log(`(Loan 2) Borrower ${signer1.address} repaid 10500 PAWN to ${signer3.address}`);

    // 3 will pay off one loan from 2
    const loan4BorrowerNoteId = await borrowerNote.tokenOfOwnerByIndex(signer3.address, 1);
    await usd.connect(signer3).approve(repaymentController.address, ethers.utils.parseUnits("1140", 6));
    await repaymentController.connect(signer3).repay(loan4BorrowerNoteId);

    console.log(`(Loan 4) Borrower ${signer3.address} repaid 1140 PUSD to ${signer2.address}`);

    console.log(SECTION_SEPARATOR);
    console.log("Bootstrapping complete!");
    console.log(SECTION_SEPARATOR);
}
