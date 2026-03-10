// script/post-deploy.js
// Reads deployment.json (written by forge script) and updates .env with contract addresses.
//
// Usage:  node script/post-deploy.js

const fs = require("fs");
const path = require("path");

const deploymentPath = path.join(__dirname, "..", "deployment.json");
const envPath = path.join(__dirname, "..", ".env");

if (!fs.existsSync(deploymentPath)) {
    console.error("deployment.json not found. Run forge script first.");
    process.exit(1);
}

const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

console.log("\n  Updating .env with deployed addresses...");
console.log(`    BatchExecutor: ${deployment.BatchExecutor}`);
console.log(`    SampleToken:   ${deployment.SampleToken}`);
console.log(`    GasSponsor:    ${deployment.GasSponsor}`);
console.log(`    Deployer:      ${deployment.Deployer}`);

let envContent = "";
if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
}

const envUpdates = {
    BATCH_EXECUTOR_ADDRESS: deployment.BatchExecutor,
    SAMPLE_TOKEN_ADDRESS: deployment.SampleToken,
    GAS_SPONSOR_ADDRESS: deployment.GasSponsor,
    RELAYER_ADDRESS: deployment.Deployer,
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
console.log("  .env updated successfully.\n");
