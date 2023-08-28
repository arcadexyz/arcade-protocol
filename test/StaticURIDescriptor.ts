import { expect } from "chai";
import { waffle, ethers } from "hardhat";

const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { MockERC721, StaticURIDescriptor } from "../typechain";
import { deploy } from "./utils/contracts";

import { BASE_URI } from "./utils/constants";

interface TestContext {
    mockERC721: MockERC721;
    descriptor: StaticURIDescriptor;
    deployer: SignerWithAddress;
}

/**
 * Sets up a test context, deploying new contracts and returning them for use in a test
 */
const fixture = async (): Promise<TestContext> => {
    const signers: SignerWithAddress[] = await ethers.getSigners();
    const [deployer] = signers;

    const mockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);
    const descriptor = <StaticURIDescriptor>await deploy("StaticURIDescriptor", signers[0], [BASE_URI])

    return { mockERC721, deployer, descriptor };
};

describe("StaticURIDescriptor", () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await loadFixture(fixture);
    });

    describe("getTokenURI", () => {
        it("returns the same token uri for every call", async () => {
            const { descriptor, mockERC721, deployer } = ctx;

            expect(await descriptor.tokenURI(mockERC721.address, 1)).to.eq(BASE_URI);
            expect(await descriptor.tokenURI(mockERC721.address, 55)).to.eq(BASE_URI);
            expect(await descriptor.tokenURI(mockERC721.address, 909790)).to.eq(BASE_URI);
            expect(await descriptor.tokenURI(deployer.address, 55)).to.eq(BASE_URI);
        });

        it("returns an empty string if baseURI is not set", async () => {
            const { descriptor, mockERC721, deployer } = ctx;

            await descriptor.setBaseURI("");

            expect(await descriptor.tokenURI(deployer.address, 10)).to.eq("");
            expect(await descriptor.tokenURI(deployer.address, 55)).to.eq("");
            expect(await descriptor.tokenURI(mockERC721.address, 55)).to.eq("");
        });
    });

    describe("setBaseURI", () => {
        const OTHER_BASE_URI = "https://example.com/";

        it("reverts if caller is not the owner", async () => {
            const { descriptor } = ctx;
            const [, other] = await ethers.getSigners();

            await expect(descriptor.connect(other).setBaseURI(OTHER_BASE_URI)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("sets a new baseURI", async () => {
            const { descriptor, deployer, mockERC721 } = ctx;

            await expect(
                descriptor.setBaseURI(OTHER_BASE_URI)
            ).to.emit(descriptor, "SetBaseURI")
                .withArgs(deployer.address, OTHER_BASE_URI);

            expect(await descriptor.baseURI()).to.eq(OTHER_BASE_URI);
            expect(await descriptor.tokenURI(mockERC721.address, 55)).to.eq(OTHER_BASE_URI);
        });

        it("sets an empty baseURI", async () => {
            const { descriptor, deployer, mockERC721 } = ctx;

            await expect(
                descriptor.setBaseURI("")
            ).to.emit(descriptor, "SetBaseURI")
                .withArgs(deployer.address, "");

            expect(await descriptor.baseURI()).to.eq("");
            expect(await descriptor.tokenURI(mockERC721.address, 55)).to.eq("");
        });
    });
});
