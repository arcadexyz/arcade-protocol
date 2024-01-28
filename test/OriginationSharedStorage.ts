import chai, { expect } from "chai";
import { waffle, ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
const { loadFixture } = waffle;
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { deploy } from "./utils/contracts";

chai.use(solidity);

import {
    MockERC20,
    MockERC721,
    ArcadeItemsVerifier,
    OriginationSharedStorage
} from "../typechain";
import { ZERO_ADDRESS } from "./utils/erc20";

import {
    ADMIN_ROLE,
    WHITELIST_MANAGER_ROLE,
    MIN_LOAN_PRINCIPAL,
} from "./utils/constants";

type Signer = SignerWithAddress;

interface TestContext {
    originationSharedStorage: OriginationSharedStorage;
    mockERC20: MockERC20;
    mockERC721: MockERC721;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

const fixture = async (): Promise<TestContext> => {
    const signers: Signer[] = await ethers.getSigners();
    const [deployer] = signers;

    const mockERC20 = <MockERC20>await deploy("MockERC20", deployer, ["Mock ERC20", "MOCK"]);
    const mockERC721 = <MockERC721>await deploy("MockERC721", deployer, ["Mock ERC721", "MOCK"]);

    const originationSharedStorage = <OriginationSharedStorage> await deploy("OriginationSharedStorage", deployer, []);

    return {
        originationSharedStorage,
        mockERC20,
        mockERC721,
        user: deployer,
        other: signers[1],
        signers: signers.slice(2),
    };
};

describe("OriginationSharedStorage", () => {
    describe("verification whitelist", () => {
        let ctx: TestContext;
        let verifier: ArcadeItemsVerifier;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
            verifier = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", ctx.user, []);
        });

        it("does not allow a non-admin to update the whitelist", async () => {
            const { other, originationSharedStorage } = ctx;

            await expect(
                originationSharedStorage.connect(other).setAllowedVerifiers([verifier.address], [true]),
            ).to.be.revertedWith(`AccessControl`);
        });

        it("Try to set 0x0000 as address, should revert.", async () => {
            const { user, originationSharedStorage } = ctx;

            await expect(
                originationSharedStorage
                    .connect(user)
                    .setAllowedVerifiers([ZERO_ADDRESS], [true]),
            ).to.be.revertedWith(`OSS_ZeroAddress("verifier")`);
        });

        it("allows the contract owner to update the whitelist", async () => {
            const { user, originationSharedStorage } = ctx;

            await expect(originationSharedStorage.connect(user).setAllowedVerifiers([verifier.address], [true]))
                .to.emit(originationSharedStorage, "SetAllowedVerifier")
                .withArgs(verifier.address, true);

            expect(await originationSharedStorage.isAllowedVerifier(verifier.address)).to.be.true;
        });

        it("does not allow a non-admin to perform a batch update", async () => {
            const { user, other, originationSharedStorage } = ctx;

            const verifier2 = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await expect(
                originationSharedStorage
                    .connect(other)
                    .setAllowedVerifiers([verifier.address, verifier2.address], [true, true]),
            ).to.be.revertedWith("AccessControl");
        });

        it("reverts if a batch update has zero elements", async () => {
            const { user, originationSharedStorage } = ctx;

            await expect(
                originationSharedStorage
                    .connect(user)
                    .setAllowedVerifiers([], []),
            ).to.be.revertedWith("OSS_ZeroArrayElements");
        });

        it("reverts if a batch update has too many elements", async () => {
            const { user, originationSharedStorage } = ctx;

            const addresses: string[] = [];
            const bools: boolean[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(verifier.address);
                bools.push(true);
            }

            await expect(
                originationSharedStorage
                    .connect(user)
                    .setAllowedVerifiers(addresses, bools),
            ).to.be.revertedWith("OSS_ArrayTooManyElements");
        });

        it("reverts if a batch update's arguments have mismatched length", async () => {
            const { user, originationSharedStorage } = ctx;

            const verifier2 = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await expect(
                originationSharedStorage
                    .connect(user)
                    .setAllowedVerifiers([verifier.address, verifier2.address], [true]),
            ).to.be.revertedWith("OSS_BatchLengthMismatch");
        });

        it("allows the contract owner to perform a batch update", async () => {
            const { user, originationSharedStorage } = ctx;

            await originationSharedStorage.connect(user).setAllowedVerifiers([verifier.address], [true]);
            expect(await originationSharedStorage.isAllowedVerifier(verifier.address)).to.be.true;

            // Deploy a new verifier, disable the first one
            const verifier2 = <ArcadeItemsVerifier>await deploy("ArcadeItemsVerifier", user, []);

            await expect(
                originationSharedStorage
                    .connect(user)
                    .setAllowedVerifiers([verifier.address, verifier2.address], [false, true]),
            )
                .to.emit(originationSharedStorage, "SetAllowedVerifier")
                .withArgs(verifier.address, false)
                .to.emit(originationSharedStorage, "SetAllowedVerifier")
                .withArgs(verifier2.address, true);

            expect(await originationSharedStorage.isAllowedVerifier(verifier.address)).to.be.false;
            expect(await originationSharedStorage.isAllowedVerifier(verifier2.address)).to.be.true;
        });

        it("only admin should be able to change whitelist manager", async () => {
            const { originationSharedStorage, user, other } = ctx;

            await originationSharedStorage.connect(user).grantRole(WHITELIST_MANAGER_ROLE, other.address);
            await originationSharedStorage.connect(user).revokeRole(WHITELIST_MANAGER_ROLE, user.address);
            await expect(
                originationSharedStorage.connect(other).grantRole(WHITELIST_MANAGER_ROLE, other.address),
            ).to.be.revertedWith(
                `AccessControl: account ${(
                    other.address
                ).toLowerCase()} is missing role ${ADMIN_ROLE}`,
            );
        });
    });

    describe("Collateral and currency whitelisting", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("Reverts when whitelist manager role tries to whitelist a currency with no address provided", async () => {
            const { originationSharedStorage, user: admin } = ctx;

            await expect(originationSharedStorage.connect(admin).setAllowedPayableCurrencies([], []))
                .to.be.revertedWith("OSS_ZeroArrayElements");
        });

        it("Reverts when whitelist manager role tries to whitelist more than 50 currencies", async () => {
            const { originationSharedStorage, user: admin, mockERC20 } = ctx;

            const addresses: string[] = [];
            const bools: { isAllowed: boolean, minPrincipal: number }[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(mockERC20.address);
                bools.push({ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL });
            }

            await expect(originationSharedStorage.connect(admin).setAllowedPayableCurrencies(addresses, bools))
                .to.be.revertedWith("OSS_ArrayTooManyElements");
        });

        it("Reverts when the currency whitelist batch update's arguments have mismatched length", async () => {
            const { originationSharedStorage, user: admin, mockERC20 } = ctx;

            const addresses: string[] = [];
            const bools: { isAllowed: boolean, minPrincipal: number }[] = [];
            for (let i = 0; i < 30; i++) addresses.push(mockERC20.address);
            for (let i = 0; i < 16; i++) bools.push({ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL });

            await expect(originationSharedStorage.connect(admin).setAllowedPayableCurrencies(addresses, bools))
                .to.be.revertedWith("OSS_BatchLengthMismatch");
        });

        it("Reverts when user without whitelist manager role tries to whitelist a currency", async () => {
            const { originationSharedStorage, other, mockERC20 } = ctx;

            await expect(originationSharedStorage.connect(other).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]))
                .to.be.revertedWith("AccessControl");
        });

        it("Reverts when whitelist manager role tries to whitelist more than 50 collateral addresses", async () => {
            const { originationSharedStorage, user: admin, mockERC721 } = ctx;

            const addresses: string[] = [];
            const bools: { isAllowed: boolean, minPrincipal: number }[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(mockERC721.address);
                bools.push({ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL });
            }

            await expect(originationSharedStorage.connect(admin).setAllowedPayableCurrencies(addresses, bools))
                .to.be.revertedWith("OSS_ArrayTooManyElements");
        });

        it("Reverts when whitelist manager role tries to whitelist payable currency zero address", async () => {
            const { originationSharedStorage, user: admin } = ctx;

            await expect(
                originationSharedStorage.connect(admin).setAllowedPayableCurrencies([ZERO_ADDRESS], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]),
            ).to.be.revertedWith(`OSS_ZeroAddress("token")`);
        });

        it("Reverts when whitelist manager role tries to remove a currency with no address provided", async () => {
            const { originationSharedStorage, user: admin } = ctx;

            await expect(
                originationSharedStorage.connect(admin).setAllowedPayableCurrencies([ZERO_ADDRESS], [{ isAllowed: false, minPrincipal: 0 }]),
            ).to.be.revertedWith(`OSS_ZeroAddress("token")`);
        });

        it("Reverts when whitelist manager role tries to remove more than 50 currencies", async () => {
            const { originationSharedStorage, user: admin, mockERC20 } = ctx;

            const addresses: string[] = [];
            const bools: { isAllowed: boolean, minPrincipal: number }[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(mockERC20.address);
                bools.push({ isAllowed: false, minPrincipal: 0 });
            }

            await expect(originationSharedStorage.connect(admin).setAllowedPayableCurrencies(addresses, bools))
                .to.be.revertedWith("OSS_ArrayTooManyElements");
        });

        it("Reverts when user without whitelist manager role tries to remove a whitelisted currency", async () => {
            const { originationSharedStorage,  other, mockERC20 } = ctx;

            await expect(originationSharedStorage.connect(other).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: false, minPrincipal: 0 }]))
                .to.be.revertedWith("AccessControl");
        });

        it("Get minimum principal reverts when the payable currency is not whitelisted", async () => {
            const { originationSharedStorage, mockERC20 } = ctx;

            await expect(originationSharedStorage.getMinPrincipal(mockERC20.address))
                .to.be.revertedWith("OSS_NotWhitelisted");
        });

        it("Reverts when whitelist manager role tries to whitelist collateral with no address provided", async () => {
            const { originationSharedStorage, user: admin } = ctx;

            await expect(originationSharedStorage.connect(admin).setAllowedCollateralAddresses([], []))
                .to.be.revertedWith("OSS_ZeroArrayElements");
        });

        it("Reverts when user without whitelist manager role tries to whitelist collateral", async () => {
            const { originationSharedStorage, other, mockERC721 } = ctx;

            await expect(originationSharedStorage.connect(other).setAllowedCollateralAddresses([mockERC721.address], [true]))
                .to.be.revertedWith("AccessControl");
        });

        it("Reverts when whitelist manager role tries to remove more than 50 collateral addresses", async () => {
            const { originationSharedStorage, user: admin, mockERC721 } = ctx;

            const addresses: string[] = [];
            const bools: boolean[] = [];
            for (let i = 0; i < 51; i++) {
                addresses.push(mockERC721.address);
                bools.push(false);
            }

            await expect(originationSharedStorage.connect(admin).setAllowedCollateralAddresses(addresses, bools))
                .to.be.revertedWith("OSS_ArrayTooManyElements");
        });

        it("Reverts when the collateral whitelist batch update's arguments have mismatched length", async () => {
            const { originationSharedStorage, user: admin, mockERC721 } = ctx;

            const addresses: string[] = [];
            const bools: boolean[] = [];
            for (let i = 0; i < 30; i++) addresses.push(mockERC721.address);
            for (let i = 0; i < 16; i++) bools.push(true);

            await expect(originationSharedStorage.connect(admin).setAllowedCollateralAddresses(addresses, bools))
                .to.be.revertedWith("OSS_BatchLengthMismatch");
        });

        it("Reverts when user without whitelist manager role tries to remove a whitelisted currency", async () => {
            const { originationSharedStorage, other, mockERC20 } = ctx;

            await expect(originationSharedStorage.connect(other).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }]))
                .to.be.revertedWith("AccessControl");
        });

        it("Whitelist manager role adds and removes whitelisted payable currency", async () => {
            const { originationSharedStorage, user: admin, mockERC20 } = ctx;

            await expect(
                originationSharedStorage.connect(admin).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: true, minPrincipal: MIN_LOAN_PRINCIPAL }])
            ).to.emit(originationSharedStorage, "SetAllowedCurrency").withArgs(mockERC20.address, true, MIN_LOAN_PRINCIPAL);

            expect(await originationSharedStorage.isAllowedCurrency(mockERC20.address)).to.be.true;

            await expect(
                originationSharedStorage.connect(admin).setAllowedPayableCurrencies([mockERC20.address], [{ isAllowed: false, minPrincipal: 0 }])
            ).to.emit(originationSharedStorage, "SetAllowedCurrency").withArgs(mockERC20.address, false, 0);

            expect(await originationSharedStorage.isAllowedCurrency(mockERC20.address)).to.be.false;
        });

        it("Reverts when whitelist manager role tries to whitelist collateral at zero address", async () => {
            const { originationSharedStorage, user: admin } = ctx;

            await expect(
                originationSharedStorage.connect(admin).setAllowedCollateralAddresses([ZERO_ADDRESS], [true]),
            ).to.be.revertedWith(`OSS_ZeroAddress("token")`);
        });

        it("Whitelist manager role adds and removes whitelisted collateral", async () => {
            const { originationSharedStorage, user: admin, mockERC721 } = ctx;

            await expect(
                originationSharedStorage.connect(admin).setAllowedCollateralAddresses([mockERC721.address], [true])
            ).to.emit(originationSharedStorage, "SetAllowedCollateral").withArgs(mockERC721.address, true);

            expect(await originationSharedStorage.isAllowedCollateral(mockERC721.address)).to.be.true;

            await expect(
                originationSharedStorage.connect(admin).setAllowedCollateralAddresses([mockERC721.address], [false])
            ).to.emit(originationSharedStorage, "SetAllowedCollateral").withArgs(mockERC721.address, false);

            expect(await originationSharedStorage.isAllowedCollateral(mockERC721.address)).to.be.false;
        });

        it("Reverts when whitelist manager role tries to whitelist collateral at zero address", async () => {
            const { originationSharedStorage, user: admin } = ctx;

            await expect(
                originationSharedStorage.connect(admin).setAllowedCollateralAddresses([ZERO_ADDRESS], [false]),
            ).to.be.revertedWith(`OSS_ZeroAddress("token")`);
        });
    });
});
