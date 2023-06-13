import { expect } from "chai";
import hre, { waffle, ethers } from "hardhat";
const { loadFixture } = waffle;
import { Signer } from "ethers";
import { FeeController } from "../typechain";
import { deploy } from "./utils/contracts";

interface TestContext {
    feeController: FeeController;
    user: Signer;
    other: Signer;
    signers: Signer[];
}

const fixture = async (): Promise<TestContext> => {
    const signers: Signer[] = await hre.ethers.getSigners();
    const feeController = <FeeController>await deploy("FeeController", signers[0], []);

    return {
        feeController,
        user: signers[0],
        other: signers[1],
        signers: signers.slice(2),
    };
};

describe("FeeController", () => {
    describe("Constructor", () => {
        it("creates Fee Controller", async () => {
            const signers: Signer[] = await hre.ethers.getSigners();
            const feeController = <FeeController>await deploy("FeeController", signers[0], []);
            expect(feeController).to.not.be.undefined;

            // Expect default max fees to be set
            expect(await feeController.getMaxFee(await feeController.FL_01())).to.equal(ethers.utils.parseEther("1"));
            expect(await feeController.getMaxFee(await feeController.FL_02())).to.equal(10_00);
            expect(await feeController.getMaxFee(await feeController.FL_03())).to.equal(10_00);
            expect(await feeController.getMaxFee(await feeController.FL_04())).to.equal(20_00);
            expect(await feeController.getMaxFee(await feeController.FL_05())).to.equal(20_00);
            expect(await feeController.getMaxFee(await feeController.FL_06())).to.equal(10_00);
            expect(await feeController.getMaxFee(await feeController.FL_07())).to.equal(50_00);
            expect(await feeController.getMaxFee(await feeController.FL_08())).to.equal(10_00);
            expect(await feeController.getMaxFee(await feeController.FL_09())).to.equal(10_00);
        });
    });

    describe("Fee Operations", () => {
        let ctx: TestContext;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        describe("set", () => {
            it("reverts if sender does not have admin role", async () => {
                const { feeController, other } = ctx;

                await expect(
                    feeController.connect(other).set(await feeController.FL_02(), 5_00)
                ).to.be.revertedWith(
                    "Ownable: caller is not the owner"
                );
            });

            it("reverts if new fee is over the maximum", async () => {
                const { feeController, user } = ctx;

                await expect(
                    feeController.connect(user).set(await feeController.FL_02(), 50_00)
                ).to.be.revertedWith(
                    "FC_FeeOverMax"
                );
            });

            it("sets a fee", async () => {
                const { feeController, user } = ctx;

                expect(await feeController.connect(user).get(await feeController.FL_02())).to.eq(0);

                await expect(
                    feeController.connect(user).set(await feeController.FL_02(), 5_00)
                ).to.emit(feeController, "SetFee")
                    .withArgs(await feeController.FL_02(), 5_00);

                expect(await feeController.connect(user).get(await feeController.FL_02())).to.eq(5_00);
            });
        });

        describe("get", () => {
            it("gets a fee", async () => {
                const { feeController, user } = ctx;

                await feeController.connect(user).set(await feeController.FL_02(), 5_00);

                expect(await feeController.connect(user).get(await feeController.FL_02())).to.eq(5_00);
            });

            it("unset fees return 0", async () => {
                const { feeController, user } = ctx;

                expect(await feeController.connect(user).get(await feeController.FL_08())).to.eq(0);
            });
        });


        describe("getMaxFee", () => {
            it("gets a max fee", async () => {
                const { feeController, user } = ctx;

                expect(
                    await feeController.connect(user).getMaxFee(await feeController.FL_02())
                ).to.eq(10_00);
            });

            it("unset max fees return 0", async () => {
                const { feeController, user } = ctx;

                expect(
                    await feeController.connect(user).getMaxFee(ethers.utils.id("UNSET_FEE"))
                ).to.eq(0);
            });
        });
    });
});
