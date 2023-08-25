import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { MockERC1155Metadata, MockERC20, MockERC721Metadata } from "../../typechain";

import { getBalance, mintTokens } from "./tokens";
import { getBalanceERC1155, mintNFTs } from "./nfts";
import { SUBSECTION_SEPARATOR } from "./constants";

export async function mintAndDistribute(
    signers: SignerWithAddress[],
    weth: MockERC20,
    pawnToken: MockERC20,
    usd: MockERC20,
    punks: MockERC721Metadata,
    art: MockERC721Metadata,
    beats: MockERC1155Metadata,
): Promise<void> {
    // Give a bunch of everything to signer[0]
    await mintTokens(signers[0].address, [1000, 500000, 2000000], weth, pawnToken, usd);
    await mintNFTs(signers[0].address, [20, 20, 20, 20], punks, art, beats);

    // Give a mix to signers[1] through signers[5]
    await mintTokens(signers[1].address, [0, 2000, 10000], weth, pawnToken, usd);
    await mintNFTs(signers[1].address, [5, 0, 2, 1], punks, art, beats);

    await mintTokens(signers[2].address, [450, 350.5, 5000], weth, pawnToken, usd);
    await mintNFTs(signers[2].address, [0, 0, 1, 0], punks, art, beats);

    await mintTokens(signers[3].address, [2, 50000, 7777], weth, pawnToken, usd);
    await mintNFTs(signers[3].address, [10, 3, 7, 0], punks, art, beats);

    await mintTokens(signers[4].address, [50, 2222.2, 12.1], weth, pawnToken, usd);
    await mintNFTs(signers[4].address, [1, 12, 1, 6], punks, art, beats);

    console.log("Initial balances:");
    for (const i in signers) {
        const signer = signers[i];
        const { address: signerAddr } = signer;

        console.log(SUBSECTION_SEPARATOR);
        console.log(`Signer ${i}: ${signerAddr}`);
        console.log("PawnPunks balance:", await getBalance(punks, signerAddr));
        console.log("PawnArt balance:", await getBalance(art, signerAddr));
        console.log("PawnBeats Edition 0 balance:", await getBalanceERC1155(beats, 0, signerAddr));
        console.log("PawnBeats Edition 1 balance:", await getBalanceERC1155(beats, 1, signerAddr));
        console.log("ETH balance:", (await signer.getBalance()).toString());
        console.log("WETH balance:", await getBalance(weth, signerAddr));
        console.log("PAWN balance:", await getBalance(pawnToken, signerAddr));
        console.log("PUSD balance:", await getBalance(usd, signerAddr));
    }
}
