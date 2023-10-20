import fs from "fs";
import { ethers } from "hardhat";

async function main(file: string) {
    const [deployer, oldAdmin] = await ethers.getSigners();

    // Your code here
    const txs = JSON.parse(fs.readFileSync(file, 'utf8'));

    for (const tx of txs) {
        console.log(`Broadcasting tx ${tx.index}...`);
        console.log(`[${tx.contractName}] Description: ${tx.description}`);
        console.log();

        const deployerIndices = [13, 14, 16, 17];
        const from = deployerIndices.includes(tx.index) ? deployer : oldAdmin;

        const broadcast = await from.sendTransaction({
            to: tx.to,
            data: tx.calldata
        });

        await broadcast.wait();
    }

    process.exit(0);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    main(process.env.ROLE_TRANSFER_FILE!)
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
