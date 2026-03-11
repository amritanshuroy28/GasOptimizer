// server.js
// Express server for the Batch Relay dApp
//
// KEY FIXES (v2):
//   - Rate limiting per IP to prevent queue flooding
//   - Input validation/sanitization on relay endpoint
//   - CORS configuration
//   - /api/batch/status endpoint for monitoring
//   - /api/batch/flush endpoint for manual flush
//   - Graceful shutdown flushes remaining queue

const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const { ethers } = require("ethers");
const { Relayer } = require("./relayer.js");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────

app.use(express.json({ limit: "100kb" })); // Limit body size
app.use(express.static(path.join(__dirname)));

// Simple CORS (allow all for dev; restrict in production)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

// ─── Simple Rate Limiter ────────────────────────────────────
// In production, use a proper rate limiter like express-rate-limit

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "30"); // 30 requests per minute

function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, []);
    }

    const timestamps = rateLimitMap.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    timestamps.push(now);
    rateLimitMap.set(ip, timestamps);

    if (timestamps.length > RATE_LIMIT_MAX) {
        return res.status(429).json({
            error: "Too many requests. Please wait before submitting more."
        });
    }

    next();
}

// Clean up rate limit map periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of rateLimitMap) {
        const active = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (active.length === 0) {
            rateLimitMap.delete(ip);
        } else {
            rateLimitMap.set(ip, active);
        }
    }
}, RATE_LIMIT_WINDOW_MS);

// ─── Input Validation ───────────────────────────────────────

function validateRelayRequest(body) {
    const { request, signature } = body;

    if (!request || typeof request !== "object") {
        return "Missing or invalid 'request' object";
    }

    if (!signature || typeof signature !== "string") {
        return "Missing or invalid 'signature' string";
    }

    // Check required fields
    const requiredFields = ["from", "to", "value", "gas", "nonce", "deadline", "data"];
    for (const field of requiredFields) {
        if (request[field] === undefined || request[field] === null) {
            return `Missing required field: request.${field}`;
        }
    }

    // Basic address format check
    if (!/^0x[0-9a-fA-F]{40}$/.test(request.from)) {
        return "Invalid 'from' address format";
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(request.to)) {
        return "Invalid 'to' address format";
    }

    // Signature format check (65 bytes = 130 hex chars + 0x prefix)
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        return "Invalid signature format (expected 65-byte hex)";
    }

    // Gas limit sanity check
    const gas = Number(request.gas);
    if (isNaN(gas) || gas < 21000 || gas > 10_000_000) {
        return "Gas limit out of range (21000 - 10000000)";
    }

    return null; // Valid
}

// ─── Initialize Relayer ─────────────────────────────────────

let relayer = null;

// Use Sepolia RPC if configured, otherwise fall back to local Anvil
const RPC_URL = process.env.SEPOLIA_RPC_URL || "http://127.0.0.1:8545";

if (process.env.RELAYER_PRIVATE_KEY && process.env.BATCH_EXECUTOR_ADDRESS) {
    relayer = new Relayer({
        rpcUrl: RPC_URL,
        relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY,
        batchExecutorAddress: process.env.BATCH_EXECUTOR_ADDRESS,
        gasSponsorAddress: process.env.GAS_SPONSOR_ADDRESS || null,
        maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || "10"),
        minBatchSize: parseInt(process.env.MIN_BATCH_SIZE || "1"),
        batchIntervalMs: parseInt(process.env.BATCH_INTERVAL_MS || "15000"),
        maxRetries: parseInt(process.env.MAX_RETRIES || "2")
    });

    relayer.startAutoFlush();
    console.log("✓ Relayer initialized and running");
} else {
    console.warn("⚠ Relayer not initialized. Missing environment variables:");
    console.warn("  - RELAYER_PRIVATE_KEY");
    console.warn("  - BATCH_EXECUTOR_ADDRESS");
}

// ─── Routes ─────────────────────────────────────────────────

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        relayer: relayer ? "initialized" : "not configured",
        queue: relayer ? relayer.getStatus() : null,
        timestamp: new Date().toISOString()
    });
});

// Serve contract addresses and network config so the frontend stays in sync
app.get("/api/config", (req, res) => {
    const isSepolia = !!process.env.SEPOLIA_RPC_URL;
    res.json({
        batchExecutorAddress: process.env.BATCH_EXECUTOR_ADDRESS || null,
        sampleTokenAddress: process.env.SAMPLE_TOKEN_ADDRESS || null,
        gasSponsorAddress: process.env.GAS_SPONSOR_ADDRESS || null,
        rpcUrl: RPC_URL,
        chainId: isSepolia ? 11155111 : 31337,
        chainName: isSepolia ? "Sepolia" : "Local",
        blockExplorer: isSepolia ? "https://sepolia.etherscan.io" : null,
    });
});

// Submit a signed request to the relayer queue
app.post("/api/relay", rateLimit, async (req, res) => {
    if (!relayer) {
        return res.status(503).json({
            error: "Relayer not configured. Check environment variables."
        });
    }

    // Validate input
    const validationError = validateRelayRequest(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    try {
        const { request, signature } = req.body;
        const result = await relayer.addRequest(request, signature);

        res.json({
            status: result.status || "queued",
            queueLength: relayer.pendingRequests.length,
            message: result.txHash
                ? `Batch executed: ${result.txHash}`
                : "Request added to batch queue"
        });
    } catch (error) {
        const statusCode = error.message.includes("Duplicate") ? 409 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// Get batch queue status
app.get("/api/batch/status", (req, res) => {
    if (!relayer) {
        return res.status(503).json({ error: "Relayer not configured" });
    }
    res.json(relayer.getStatus());
});

// Gas usage statistics and history
app.get("/api/gas-stats", (req, res) => {
    if (!relayer) {
        return res.status(503).json({ error: "Relayer not configured" });
    }
    res.json(relayer.getGasStats());
});

// Get current on-chain nonce for a user address (helps frontend stay in sync)
app.get("/api/nonce/:address", async (req, res) => {
    if (!relayer) {
        return res.status(503).json({ error: "Relayer not configured" });
    }

    const address = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return res.status(400).json({ error: "Invalid address format" });
    }

    try {
        const nonce = await relayer.getNonceForUser(address);
        res.json({ address, nonce });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Force flush the current queue (admin endpoint)
app.post("/api/batch/flush", rateLimit, async (req, res) => {
    if (!relayer) {
        return res.status(503).json({ error: "Relayer not configured" });
    }

    try {
        const result = await relayer.forceFlush();
        res.json({
            status: result ? "flushed" : "empty",
            result
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── Token Faucet ──────────────────────────────────────────
// Mints a small amount of SMPL tokens to any connected wallet for testing.
// Uses the deployer wallet (contract owner) to call mint() — unlimited supply.

const FAUCET_AMOUNT = process.env.FAUCET_AMOUNT || "100"; // tokens per request
const faucetCooldowns = new Map(); // address -> last claim timestamp
const FAUCET_COOLDOWN_MS = 60_000 * 5; // 5 minutes between claims per address

app.post("/api/faucet", rateLimit, async (req, res) => {
    const { address } = req.body;

    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return res.status(400).json({ error: "Invalid wallet address" });
    }

    if (!process.env.DEPLOYER_PRIVATE_KEY || !process.env.SAMPLE_TOKEN_ADDRESS) {
        return res.status(503).json({ error: "Faucet not configured. Missing DEPLOYER_PRIVATE_KEY or SAMPLE_TOKEN_ADDRESS." });
    }

    // Cooldown check
    const lastClaim = faucetCooldowns.get(address.toLowerCase());
    if (lastClaim && Date.now() - lastClaim < FAUCET_COOLDOWN_MS) {
        const waitSec = Math.ceil((FAUCET_COOLDOWN_MS - (Date.now() - lastClaim)) / 1000);
        return res.status(429).json({ error: `Please wait ${waitSec}s before claiming again.` });
    }

    try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
        const token = new ethers.Contract(
            process.env.SAMPLE_TOKEN_ADDRESS,
            ["function mint(address to, uint256 amount)", "function decimals() view returns (uint8)"],
            wallet
        );

        const decimals = await token.decimals();
        const amount = ethers.parseUnits(FAUCET_AMOUNT, decimals);

        const tx = await token.mint(address, amount);
        const receipt = await tx.wait();

        faucetCooldowns.set(address.toLowerCase(), Date.now());

        res.json({
            status: "success",
            amount: `${FAUCET_AMOUNT} SMPL`,
            txHash: receipt.hash,
        });
    } catch (error) {
        console.error("Faucet error:", error.message);
        res.status(500).json({ error: "Faucet transfer failed: " + error.message });
    }
});

// ─── Start Server ───────────────────────────────────────────

const server = app.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log("\nEndpoints:");
    console.log(`  GET  /                 - HTML interface`);
    console.log(`  GET  /health           - Health check`);
    console.log(`  GET  /api/config       - Contract addresses`);
    console.log(`  POST /api/relay        - Submit signed transaction`);
    console.log(`  GET  /api/batch/status - Queue status`);
    console.log(`  GET  /api/gas-stats    - Gas usage analytics`);
    console.log(`  GET  /api/nonce/:addr  - On-chain nonce for address`);
    console.log(`  POST /api/batch/flush  - Force flush queue`);
    console.log(`  POST /api/faucet       - Get test tokens\n`);
});

// ─── Graceful Shutdown ──────────────────────────────────────

async function shutdown() {
    console.log("\nShutting down gracefully...");

    if (relayer) {
        relayer.stop();

        // Flush remaining requests before exit
        if (relayer.pendingRequests.length > 0) {
            console.log(`Flushing ${relayer.pendingRequests.length} remaining requests...`);
            try {
                await relayer.forceFlush();
            } catch (e) {
                console.error("Final flush failed:", e.message);
            }
        }
    }

    server.close(() => {
        console.log("Server closed.");
        process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
