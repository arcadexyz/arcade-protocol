import { expect } from "chai";
import { waffle, ethers } from "hardhat";

const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { ReflectiveURIDescriptor, MockERC721 } from "../typechain";
import { deploy } from "./utils/contracts";

import { BASE_URI } from "./utils/constants";

interface TestContext {
    mockERC721: MockERC721;
    descriptor: ReflectiveURIDescriptor;
    deployer: SignerWithAddress;
}

/**
 * Sets up a test context, deploying new contracts and returning them for use in a test
 */
const fixture = async (): Promise<TestContext> => {
    const signers: SignerWithAddress[] = await ethers.getSigners();
    const [deployer] = signers;

    const mockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);
    const descriptor = <ReflectiveURIDescriptor>await deploy("ReflectiveURIDescriptor", signers[0], [BASE_URI])

    return { mockERC721, deployer, descriptor };
};

describe("ReflectiveURIDescriptor", () => {
    let ctx: TestContext;

    beforeEach(async () => {
        ctx = await loadFixture(fixture);
    });

    describe("getTokenURI", () => {
        it("returns a tokenURI with the token ID suffix", async () => {
            const { descriptor, mockERC721 } = ctx;

            const expectedUri = (id: number) => `${BASE_URI}${mockERC721.address.toLowerCase()}/assets/${id}/metadata`;

            expect(await descriptor.tokenURI(mockERC721.address, 1)).to.equal(expectedUri(1));
            expect(await descriptor.tokenURI(mockERC721.address, 55)).to.equal(expectedUri(55));
            expect(await descriptor.tokenURI(mockERC721.address, 909790)).to.equal(expectedUri(909790));
        });

        it("returns different tokenURIs based on the target address", async () => {
            const { descriptor, mockERC721, deployer } = ctx;

            expect(await descriptor.tokenURI(mockERC721.address, 55)).to.equal(`${BASE_URI}${mockERC721.address.toLowerCase() }/assets/55/metadata`);
            expect(await descriptor.tokenURI(deployer.address, 55)).to.equal(`${BASE_URI}${deployer.address.toLowerCase() }/assets/55/metadata`);
        });

        it("returns an empty string if baseURI is not set", async () => {
            const { descriptor, mockERC721, deployer } = ctx;

            await descriptor.setBaseURI("");

            expect(await descriptor.tokenURI(deployer.address, 10)).to.equal("");
            expect(await descriptor.tokenURI(deployer.address, 55)).to.equal("");
            expect(await descriptor.tokenURI(mockERC721.address, 55)).to.equal("");
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

            expect(await descriptor.baseURI()).to.equal(OTHER_BASE_URI);
            expect(await descriptor.tokenURI(mockERC721.address, 55)).to.equal(`${OTHER_BASE_URI}${mockERC721.address.toLowerCase()}/assets/55/metadata`);
        });

        it("sets an empty baseURI", async () => {
            const { descriptor, deployer, mockERC721 } = ctx;

            await expect(
                descriptor.setBaseURI("")
            ).to.emit(descriptor, "SetBaseURI")
                .withArgs(deployer.address, "");

            expect(await descriptor.baseURI()).to.equal("");
            expect(await descriptor.tokenURI(mockERC721.address, 55)).to.equal("");
        });
    });
});
