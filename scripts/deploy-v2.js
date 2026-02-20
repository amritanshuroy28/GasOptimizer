import hre from "hardhat";
import { formatEther, parseEther } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    // Hardhat 3: ethers is on the network connection, not on hre
    const connection = await hre.network.connect();
    const ethers = connection.ethers;
    const networkName = connection.networkName;

    const [deployer] = await ethers.getSigners();

    console.log("╔══════════════════════════════════════════════╗");
    console.log("║     Batch Executor — Contract Deployment     ║");
    console.log("╠══════════════════════════════════════════════╣");
    console.log(`║  Network:  ${networkName.padEnd(33)}║`);
    console.log(`║  Deployer: ${deployer.address.substring(0, 30)}...  ║`);
    console.log("╚══════════════════════════════════════════════╝");

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`\nDeployer balance: ${formatEther(balance)} ETH`);

    if (balance === 0n) {
        console.error("ERROR: Deployer has no ETH. Get testnet ETH first.");
        process.exit(1);
    }

    // ── 1. Deploy BatchExecutor ──────────────────────────────────
    console.log("\n[1/3] Deploying BatchExecutor...");
    const BatchExecutor = await ethers.getContractFactory("BatchExecutor");
    const minBatchSize = 1; // Allow single requests
    const batchExecutor = await BatchExecutor.deploy(minBatchSize);
    await batchExecutor.waitForDeployment();
    const batchExecutorAddress = await batchExecutor.getAddress();
    console.log(`  ✓ BatchExecutor deployed at: ${batchExecutorAddress}`);

    // ── 2. Deploy SampleToken ────────────────────────────────────
    console.log("\n[2/3] Deploying SampleToken...");
    const SampleToken = await ethers.getContractFactory("SampleToken");
    const sampleToken = await SampleToken.deploy(batchExecutorAddress);
    await sampleToken.waitForDeployment();
    const sampleTokenAddress = await sampleToken.getAddress();
    console.log(`  ✓ SampleToken deployed at: ${sampleTokenAddress}`);
    console.log(`    Trusted Forwarder: ${batchExecutorAddress}`);

    // ── 3. Deploy GasSponsor ─────────────────────────────────────
    console.log("\n[3/3] Deploying GasSponsor...");
    const GasSponsor = await ethers.getContractFactory("GasSponsor");
    const maxPerClaim = parseEther("0.05");
    const dailyLimitPerRelayer = parseEther("1.0");
    const dailyLimitPerUser = parseEther("0.01");
    const globalDailyLimit = parseEther("5.0");
    const gasSponsor = await GasSponsor.deploy(
        maxPerClaim,
        dailyLimitPerRelayer,
        dailyLimitPerUser,
        globalDailyLimit
    );
    await gasSponsor.waitForDeployment();
    const gasSponsorAddress = await gasSponsor.getAddress();
    console.log(`  ✓ GasSponsor deployed at: ${gasSponsorAddress}`);

    // ── 4. Whitelist the relayer in GasSponsor ───────────────────
    console.log("\n[4] Whitelisting relayer in GasSponsor...");
    const relayerAddress = deployer.address; // Deployer is also the relayer
    const tx = await gasSponsor.setRelayer(relayerAddress, true);
    await tx.wait();
    console.log(`  ✓ Relayer ${relayerAddress} whitelisted`);

    // ── 5. Save deployment info ──────────────────────────────────
    const deploymentInfo = {
        timestamp: new Date().toISOString(),
        network: networkName,
        deployer: deployer.address,
        contracts: {
            BatchExecutor: {
                address: batchExecutorAddress,
            },
            SampleToken: {
                address: sampleTokenAddress,
                trustForwarder: batchExecutorAddress,
            },
            GasSponsor: {
                address: gasSponsorAddress,
                limits: {
                    maxPerClaim: "0.05 ETH",
                    dailyLimitPerRelayer: "1.0 ETH",
                    dailyLimitPerUser: "0.01 ETH",
                    globalDailyLimit: "5.0 ETH",
                },
            },
        },
    };

    const deploymentPath = path.join(__dirname, "..", "deployment.json");
    fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
    console.log(`\n✓ Deployment info saved to deployment.json`);

    // ── 6. Update .env file ──────────────────────────────────────
    const envPath = path.join(__dirname, "..", ".env");
    let envContent = "";
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, "utf-8");
    }

    const envUpdates = {
        BATCH_EXECUTOR_ADDRESS: batchExecutorAddress,
        SAMPLE_TOKEN_ADDRESS: sampleTokenAddress,
        GAS_SPONSOR_ADDRESS: gasSponsorAddress,
        RELAYER_ADDRESS: relayerAddress,
    };

    for (const [key, value] of Object.entries(envUpdates)) {
        const regex = new RegExp(`^${key}=.*$`, "m");
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}`;
        }
    }

    fs.writeFileSync(envPath, envContent.trim() + "\n");
    console.log("✓ .env updated with contract addresses");

    // ── Summary ──────────────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║           Deployment Complete!               ║");
    console.log("╠══════════════════════════════════════════════╣");
    console.log(`║  BatchExecutor: ${batchExecutorAddress.substring(0, 26)}...  ║`);
    console.log(`║  SampleToken:   ${sampleTokenAddress.substring(0, 26)}...  ║`);
    console.log(`║  GasSponsor:    ${gasSponsorAddress.substring(0, 26)}...  ║`);
    console.log("╚══════════════════════════════════════════════╝");
    console.log("\nNext steps:");
    console.log("  1. Fund the GasSponsor pool with ETH");
    console.log("  2. Run: npm start");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
