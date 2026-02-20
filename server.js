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

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Relayer } from "./relayer.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    const requiredFields = ["from", "to", "value", "gas", "nonce", "data"];
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

const GANACHE_RPC_URL = process.env.GANACHE_RPC_URL || "http://127.0.0.1:7545";

if (process.env.RELAYER_PRIVATE_KEY && process.env.BATCH_EXECUTOR_ADDRESS) {
    relayer = new Relayer({
        rpcUrl: GANACHE_RPC_URL,
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

// ─── Start Server ───────────────────────────────────────────

const server = app.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log("\nEndpoints:");
    console.log(`  GET  /                 - HTML interface`);
    console.log(`  GET  /health           - Health check`);
    console.log(`  POST /api/relay        - Submit signed transaction`);
    console.log(`  GET  /api/batch/status - Queue status`);
    console.log(`  POST /api/batch/flush  - Force flush queue\n`);
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
