import { Contract } from "ethers";
import { MockERC1155Metadata, MockERC721Metadata } from "../../typechain";

export async function getBalanceERC1155(asset: Contract, id: number, addr: string): Promise<string> {
    return (await asset.balanceOf(addr, id)).toString();
}

export async function mintNFTs(
    target: string,
    [numPunks, numArts, numBeats0, numBeats1]: [number, number, number, number],
    punks: MockERC721Metadata,
    art: MockERC721Metadata,
    beats: MockERC1155Metadata,
): Promise<void> {
    let j = 1;

    for (let i = 0; i < numPunks; i++) {
        await punks["mint(address,string)"](
            target,
            `https://s3.amazonaws.com/images.pawn.fi/test-nft-metadata/PawnFiPunks/nft-${j++}.json`,
        );
    }

    for (let i = 0; i < numArts; i++) {
        await art["mint(address,string)"](
            target,
            `https://s3.amazonaws.com/images.pawn.fi/test-nft-metadata/PawnArtIo/nft-${j++}.json`,
        );
    }

    const uris = [
        `https://s3.amazonaws.com/images.pawn.fi/test-nft-metadata/PawnBeats/nft-${j++}.json`,
        `https://s3.amazonaws.com/images.pawn.fi/test-nft-metadata/PawnBeats/nft-${j++}.json`,
    ];

    await beats.mintBatch(target, [0, 1], [numBeats0, numBeats1], uris, "0x00");
}
