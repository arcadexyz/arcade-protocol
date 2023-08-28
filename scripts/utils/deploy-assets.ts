import { ethers } from "hardhat";

import { MockERC1155Metadata, MockERC20, MockERC721Metadata } from "../../typechain";

import { SECTION_SEPARATOR } from "./constants";

interface DeployedNFT {
    punks: MockERC721Metadata;
    art: MockERC721Metadata;
    beats: MockERC1155Metadata;
    weth: MockERC20;
    pawnToken: MockERC20;
    usd: MockERC20;
}

export async function deployNFTs(): Promise<DeployedNFT> {
    console.log("Deploying NFTs...\n");
    const erc721Factory = await ethers.getContractFactory("MockERC721Metadata");
    const erc1155Factory = await ethers.getContractFactory("MockERC1155Metadata");

    const punks = <MockERC721Metadata>await erc721Factory.deploy("PawnFiPunks", "PFPUNKS");
    console.log("(ERC721) PawnFiPunks deployed to:", punks.address);

    const art = <MockERC721Metadata>await erc721Factory.deploy("PawnArt.io", "PWART");
    console.log("(ERC721) PawnArt.io deployed to:", art.address);

    const beats = <MockERC1155Metadata>await erc1155Factory.deploy();
    console.log("(ERC1155) PawnBeats deployed to:", beats.address);

    // Deploy some ERC20s
    console.log(SECTION_SEPARATOR);
    console.log("Deploying Tokens...\n");
    const erc20Factory = await ethers.getContractFactory("ERC20PresetMinterPauser");
    const erc20WithDecimalsFactory = await ethers.getContractFactory("MockERC20WithDecimals");

    const weth = <MockERC20>await erc20Factory.deploy("Wrapped Ether", "WETH");
    console.log("(ERC20) WETH deployed to:", weth.address);

    const pawnToken = <MockERC20>await erc20Factory.deploy("PawnToken", "PAWN");
    console.log("(ERC20) PAWN deployed to:", pawnToken.address);

    const usd = <MockERC20>await erc20WithDecimalsFactory.deploy("USD Stablecoin", "PUSD", 6);
    console.log("(ERC20) PUSD deployed to:", usd.address);

    return { punks, art, beats, weth, pawnToken, usd };
}
