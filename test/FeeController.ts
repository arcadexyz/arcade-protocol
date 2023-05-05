import { expect } from "chai";
import hre, { waffle } from "hardhat";
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

describe.skip("FeeController", () => {
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

    describe("constructor", () => {
        it("creates Fee Controller", async () => {
            const signers: Signer[] = await hre.ethers.getSigners();
            expect(await deploy("FeeController", signers[0], []));
        });

        describe("setOriginationFee", () => {
            it("reverts if sender does not have admin role", async () => {
                const { feeController, other } = await loadFixture(fixture);
                await expect(feeController.connect(other).setOriginationFee(1234)).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("reverts if new fee is over the maximum", async () => {
                const { feeController, user } = await loadFixture(fixture);
                await expect(feeController.connect(user).setOriginationFee(10_000)).to.be.revertedWith(
                    "FC_FeeTooLarge",
                );
            });

            it("sets origination fee", async () => {
                const { feeController, user } = await loadFixture(fixture);
                await expect(feeController.connect(user).setOriginationFee(123))
                    .to.emit(feeController, "UpdateOriginationFee")
                    .withArgs(123);
            });
        });

        describe("getOriginationFee", () => {
            it("initially returns 0.5%", async () => {
                const { feeController, user } = await loadFixture(fixture);
                const originationFee = await feeController.connect(user).getOriginationFee();
                expect(originationFee).to.equal(50);
            });

            it("returns updated origination fee after set", async () => {
                const { feeController, user } = await loadFixture(fixture);
                const newFee = 200;

                await feeController.connect(user).setOriginationFee(newFee);

                const originationFee = await feeController.connect(user).getOriginationFee();
                expect(originationFee).to.equal(newFee);
            });
        });

        describe("setRolloverFee", () => {
            it("reverts if sender does not have admin role", async () => {
                const { feeController, other } = await loadFixture(fixture);
                await expect(feeController.connect(other).setRolloverFee(1234)).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("reverts if new fee is over the maximum", async () => {
                const { feeController, user } = await loadFixture(fixture);
                await expect(feeController.connect(user).setRolloverFee(10_000)).to.be.revertedWith("FC_FeeTooLarge");
            });

            it("sets rollover fee", async () => {
                const { feeController, user } = await loadFixture(fixture);
                await expect(feeController.connect(user).setRolloverFee(123))
                    .to.emit(feeController, "UpdateRolloverFee")
                    .withArgs(123);
            });
        });

        describe("getRolloverFee", () => {
            it("initially returns 0.1%", async () => {
                const { feeController, user } = await loadFixture(fixture);
                const originationFee = await feeController.connect(user).getRolloverFee();
                expect(originationFee).to.equal(10);
            });

            it("returns updated rollover fee after set", async () => {
                const { feeController, user } = await loadFixture(fixture);
                const newFee = 200;

                await feeController.connect(user).setRolloverFee(newFee);

                const rolloverFee = await feeController.connect(user).getRolloverFee();
                expect(rolloverFee).to.equal(newFee);
            });
        });

        describe("setCollateralSaleFee", () => {
            it("reverts if sender does not have admin role", async () => {
                const { feeController, other } = await loadFixture(fixture);
                await expect(feeController.connect(other).setCollateralSaleFee(1234)).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("reverts if new fee is over the maximum", async () => {
                const { feeController, user } = await loadFixture(fixture);
                await expect(feeController.connect(user).setCollateralSaleFee(10_000)).to.be.revertedWith(
                    "FC_FeeTooLarge",
                );
            });

            it("sets collateralSale fee", async () => {
                const { feeController, user } = await loadFixture(fixture);
                await expect(feeController.connect(user).setCollateralSaleFee(123))
                    .to.emit(feeController, "UpdateCollateralSaleFee")
                    .withArgs(123);
            });
        });

        describe("getCollateralSaleFee", () => {
            it("initially returns 0.0%", async () => {
                const { feeController, user } = await loadFixture(fixture);
                const collateralSaleFee = await feeController.connect(user).getCollateralSaleFee();
                expect(collateralSaleFee).to.equal(0);
            });

            it("returns updated collateralSale fee after set", async () => {
                const { feeController, user } = await loadFixture(fixture);
                const newFee = 200;

                await feeController.connect(user).setCollateralSaleFee(newFee);

                const collateralSaleFee = await feeController.connect(user).getCollateralSaleFee();
                expect(collateralSaleFee).to.equal(newFee);
            });
        });

        describe("setPayLaterFee", () => {
            it("reverts if sender does not have admin role", async () => {
                const { feeController, other } = await loadFixture(fixture);
                await expect(feeController.connect(other).setPayLaterFee(1234)).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("reverts if new fee is over the maximum", async () => {
                const { feeController, user } = await loadFixture(fixture);
                await expect(feeController.connect(user).setPayLaterFee(10_000)).to.be.revertedWith("FC_FeeTooLarge");
            });

            it("sets payLater fee", async () => {
                const { feeController, user } = await loadFixture(fixture);
                await expect(feeController.connect(user).setPayLaterFee(123))
                    .to.emit(feeController, "UpdatePayLaterFee")
                    .withArgs(123);
            });
        });

        describe("getPayLaterFee", () => {
            it("initially returns 0.0%", async () => {
                const { feeController, user } = await loadFixture(fixture);
                const payLaterFee = await feeController.connect(user).getPayLaterFee();
                expect(payLaterFee).to.equal(0);
            });

            it("returns updated payLater fee after set", async () => {
                const { feeController, user } = await loadFixture(fixture);
                const newFee = 200;

                await feeController.connect(user).setPayLaterFee(newFee);

                const payLaterFee = await feeController.connect(user).getPayLaterFee();
                expect(payLaterFee).to.equal(newFee);
            });
        });
    });
});
