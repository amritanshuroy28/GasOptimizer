// Deploy all contracts: BatchExecutor, SampleToken, GasSponsor
// Truffle migration script for the Gas Optimizer project.

const BatchExecutor = artifacts.require("BatchExecutor");
const SampleToken = artifacts.require("SampleToken");
const GasSponsor = artifacts.require("GasSponsor");

const fs = require("fs");
const path = require("path");

module.exports = async function (deployer, network, accounts) {
  const deployerAddress = accounts[0];

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║     Batch Executor — Contract Deployment     ║");
  console.log("╠══════════════════════════════════════════════╣");
  console.log(`║  Network:  ${network.padEnd(33)}║`);
  console.log(`║  Deployer: ${deployerAddress.substring(0, 30)}...  ║`);
  console.log("╚══════════════════════════════════════════════╝");

  // ── 1. Deploy BatchExecutor ──────────────────────────────────
  console.log("\n[1/3] Deploying BatchExecutor...");
  const minBatchSize = 1; // Allow single requests
  await deployer.deploy(BatchExecutor, minBatchSize);
  const batchExecutor = await BatchExecutor.deployed();
  console.log(`  ✓ BatchExecutor deployed at: ${batchExecutor.address}`);

  // ── 2. Deploy SampleToken ────────────────────────────────────
  console.log("\n[2/3] Deploying SampleToken...");
  await deployer.deploy(SampleToken, batchExecutor.address);
  const sampleToken = await SampleToken.deployed();
  console.log(`  ✓ SampleToken deployed at: ${sampleToken.address}`);
  console.log(`    Trusted Forwarder: ${batchExecutor.address}`);

  // ── 3. Deploy GasSponsor ─────────────────────────────────────
  console.log("\n[3/3] Deploying GasSponsor...");
  const maxPerClaim = web3.utils.toWei("0.05", "ether");
  const dailyLimitPerRelayer = web3.utils.toWei("1.0", "ether");
  const dailyLimitPerUser = web3.utils.toWei("0.01", "ether");
  const globalDailyLimit = web3.utils.toWei("5.0", "ether");
  await deployer.deploy(
    GasSponsor,
    maxPerClaim,
    dailyLimitPerRelayer,
    dailyLimitPerUser,
    globalDailyLimit
  );
  const gasSponsor = await GasSponsor.deployed();
  console.log(`  ✓ GasSponsor deployed at: ${gasSponsor.address}`);

  // ── 4. Whitelist the relayer in GasSponsor ───────────────────
  console.log("\n[4] Whitelisting relayer in GasSponsor...");
  const relayerAddress = deployerAddress; // Deployer is also the relayer
  await gasSponsor.setRelayer(relayerAddress, true);
  console.log(`  ✓ Relayer ${relayerAddress} whitelisted`);

  // ── 5. Save deployment info ──────────────────────────────────
  const deploymentInfo = {
    timestamp: new Date().toISOString(),
    network: network,
    deployer: deployerAddress,
    contracts: {
      BatchExecutor: {
        address: batchExecutor.address,
      },
      SampleToken: {
        address: sampleToken.address,
        trustForwarder: batchExecutor.address,
      },
      GasSponsor: {
        address: gasSponsor.address,
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
    BATCH_EXECUTOR_ADDRESS: batchExecutor.address,
    SAMPLE_TOKEN_ADDRESS: sampleToken.address,
    GAS_SPONSOR_ADDRESS: gasSponsor.address,
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
  console.log(`║  BatchExecutor: ${batchExecutor.address.substring(0, 26)}...  ║`);
  console.log(`║  SampleToken:   ${sampleToken.address.substring(0, 26)}...  ║`);
  console.log(`║  GasSponsor:    ${gasSponsor.address.substring(0, 26)}...  ║`);
  console.log("╚══════════════════════════════════════════════╝");
  console.log("\nNext steps:");
  console.log("  1. Fund the GasSponsor pool with ETH");
  console.log("  2. Run: npm start");
};
