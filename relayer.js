// relayer.js
// Batch transaction relay engine with queue management and gas sponsorship.
//
// KEY FIXES (v2):
//   - Nonce ordering: requests are sorted by (from, nonce) before submission
//   - Deduplication: duplicate (from, nonce) pairs are rejected at queue time
//   - Min batch threshold: configurable minimum to avoid wasteful small batches
//   - Max retries: failed batches retry up to N times, then discard stale requests
//   - Pre-verification: batch verifyBatch() call before submission to filter invalids
//   - Gas price awareness: uses provider fee data for better cost estimation

const { ethers } = require("ethers");
const dotenv = require("dotenv");

dotenv.config();

// --- Contract ABIs ---
const BATCH_EXECUTOR_ABI = [
    "function executeBatch((address from, address to, uint256 value, uint256 gas, uint256 nonce, uint256 deadline, bytes data)[] requests, bytes[] signatures) external payable returns (bool[])",
    "function verify((address from, address to, uint256 value, uint256 gas, uint256 nonce, uint256 deadline, bytes data) req, bytes signature) external view returns (bool)",
    "function verifyBatch((address from, address to, uint256 value, uint256 gas, uint256 nonce, uint256 deadline, bytes data)[] requests, bytes[] signatures) external view returns (bool[])",
    "function getNonce(address from) external view returns (uint256)",
    "event BatchExecuted(address indexed relayer, uint256 totalRequests, uint256 successCount)"
];

const GAS_SPONSOR_ABI = [
    "function claim(uint256 amount, address[] calldata users) external",
    "function estimateReimbursement(uint256, address, address[]) external view returns (uint256, bool)",
    "function getBalance() external view returns (uint256)"
];

class Relayer {
    constructor(config) {
        this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
        this.wallet = new ethers.Wallet(config.relayerPrivateKey, this.provider);

        this.batchExecutor = new ethers.Contract(
            config.batchExecutorAddress,
            BATCH_EXECUTOR_ABI,
            this.wallet
        );

        this.gasSponsor = config.gasSponsorAddress
            ? new ethers.Contract(config.gasSponsorAddress, GAS_SPONSOR_ABI, this.wallet)
            : null;

        // Queue of pending requests
        this.pendingRequests = [];
        this.pendingSignatures = [];

        // Settings
        this.maxBatchSize = config.maxBatchSize || 10;
        this.minBatchSize = config.minBatchSize || 1;  // iBatch MinX policy
        this.batchIntervalMs = config.batchIntervalMs || 15000;
        this.maxRetries = config.maxRetries || 2;

        // Track seen (from, nonce) pairs for dedup
        this._seenKeys = new Set();

        // Track retry count per batch attempt
        this._retryCount = 0;

        // Gas history tracking — stores last N batch results for analytics
        this._gasHistory = [];
        this._maxHistorySize = 100;
    }

    /**
     * Generate a dedup key for a request.
     */
    _dedupKey(request) {
        return `${request.from.toLowerCase()}-${request.nonce}`;
    }

    /**
     * Add a signed request to the queue.
     * Validates signature on-chain before accepting.
     * Rejects duplicates by (from, nonce).
     * Auto-syncs nonce check to detect stale requests early.
     */
    async addRequest(request, signature) {
        // Dedup check (fast, no RPC call)
        const key = this._dedupKey(request);
        if (this._seenKeys.has(key)) {
            throw new Error(`Duplicate request: ${request.from} nonce ${request.nonce}`);
        }

        // Check deadline hasn't passed
        if (request.deadline && request.deadline !== 0) {
            const block = await this.provider.getBlock("latest");
            if (block && block.timestamp > request.deadline) {
                throw new Error("Request has expired (deadline passed)");
            }
        }

        // Nonce sync check — reject obviously stale requests before
        // hitting the (more expensive) on-chain verify call
        const onChainNonce = Number(await this.batchExecutor.getNonce(request.from));
        if (Number(request.nonce) < onChainNonce) {
            throw new Error(
                `Stale nonce: request has nonce ${request.nonce} but on-chain nonce is ${onChainNonce}. ` +
                `This request was likely already executed or the nonce was skipped.`
            );
        }

        // Verify the signature on-chain before accepting
        const isValid = await this.batchExecutor.verify(request, signature);
        if (!isValid) {
            throw new Error("Invalid signature or nonce");
        }

        this._seenKeys.add(key);
        this.pendingRequests.push(request);
        this.pendingSignatures.push(signature);

        console.log(`Request queued from ${request.from} (nonce: ${request.nonce})`);
        console.log(`Queue size: ${this.pendingRequests.length}`);

        // If queue is full, flush immediately
        if (this.pendingRequests.length >= this.maxBatchSize) {
            return await this.flushBatch();
        }

        return { status: "queued", queueSize: this.pendingRequests.length };
    }

    /**
     * Sort requests by (from, nonce) for optimal on-chain processing.
     * Sequential nonces from the same sender must be in order.
     */
    _sortRequests(requests, signatures) {
        const paired = requests.map((req, i) => ({ req, sig: signatures[i] }));
        paired.sort((a, b) => {
            const addrCmp = a.req.from.toLowerCase().localeCompare(b.req.from.toLowerCase());
            if (addrCmp !== 0) return addrCmp;
            return Number(a.req.nonce) - Number(b.req.nonce);
        });
        return {
            requests: paired.map(p => p.req),
            signatures: paired.map(p => p.sig)
        };
    }

    /**
     * Pre-filter requests using batch verification.
     * Removes requests that would fail on-chain, saving gas.
     */
    async _preFilter(requests, signatures) {
        try {
            const validFlags = await this.batchExecutor.verifyBatch(requests, signatures);
            const filtered = { requests: [], signatures: [] };
            const rejected = [];

            for (let i = 0; i < requests.length; i++) {
                if (validFlags[i]) {
                    filtered.requests.push(requests[i]);
                    filtered.signatures.push(signatures[i]);
                } else {
                    rejected.push(requests[i]);
                    console.warn(`Pre-filter rejected: ${requests[i].from} nonce ${requests[i].nonce}`);
                }
            }

            if (rejected.length > 0) {
                console.log(`Pre-filter removed ${rejected.length}/${requests.length} invalid requests`);
            }

            return filtered;
        } catch (error) {
            console.warn("Pre-filter failed, submitting all:", error.message);
            return { requests, signatures };
        }
    }

    /**
     * Submit all queued requests as one batch transaction.
     */
    async flushBatch() {
        if (this.pendingRequests.length === 0) {
            console.log("No pending requests to flush.");
            return null;
        }

        // Check minimum batch size (iBatch MinX policy)
        if (this.pendingRequests.length < this.minBatchSize) {
            console.log(`Queue (${this.pendingRequests.length}) below minimum (${this.minBatchSize}), waiting...`);
            return null;
        }

        const rawRequests = [...this.pendingRequests];
        const rawSignatures = [...this.pendingSignatures];

        // Clear the queue and dedup set
        this.pendingRequests = [];
        this.pendingSignatures = [];
        for (const req of rawRequests) {
            this._seenKeys.delete(this._dedupKey(req));
        }

        // Sort by (from, nonce) for optimal processing
        const sorted = this._sortRequests(rawRequests, rawSignatures);

        // Pre-filter invalid requests
        const { requests, signatures } = await this._preFilter(sorted.requests, sorted.signatures);

        if (requests.length === 0) {
            console.log("All requests filtered out, nothing to submit.");
            return null;
        }

        console.log(`\nSubmitting batch of ${requests.length} requests...`);

        try {
            // Estimate gas
            const estimatedGas = await this.batchExecutor.executeBatch.estimateGas(
                requests, signatures
            );
            console.log(`Estimated gas: ${estimatedGas.toString()}`);

            // Get current fee data for better pricing
            const feeData = await this.provider.getFeeData();

            // Submit the batch transaction
            const txOptions = {
                gasLimit: estimatedGas * 130n / 100n  // 30% buffer for safety
            };

            // Use EIP-1559 pricing if available
            if (feeData.maxFeePerGas) {
                txOptions.maxFeePerGas = feeData.maxFeePerGas;
                txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
            }

            const tx = await this.batchExecutor.executeBatch(
                requests, signatures, txOptions
            );

            console.log(`Transaction submitted: ${tx.hash}`);

            const receipt = await tx.wait();
            console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
            console.log(`Actual gas used: ${receipt.gasUsed.toString()}`);

            // Reset retry count on success
            this._retryCount = 0;

            // Calculate cost
            const effectiveGasPrice = receipt.gasPrice || receipt.effectiveGasPrice;
            if (effectiveGasPrice) {
                const gasCost = receipt.gasUsed * effectiveGasPrice;
                console.log(`Gas cost: ${ethers.formatEther(gasCost)} ETH`);

                // Claim reimbursement from GasSponsor
                if (this.gasSponsor) {
                    const users = [...new Set(requests.map(req => req.from))];
                    await this.claimReimbursement(gasCost, users);
                }
            }

            // Record gas history for analytics
            const individualEstimate = BigInt(requests.length) * 58008n;
            const batchGas = BigInt(receipt.gasUsed);
            const savings = individualEstimate > batchGas
                ? Number((individualEstimate - batchGas) * 100n / individualEstimate)
                : 0;

            this._gasHistory.push({
                timestamp: new Date().toISOString(),
                txHash: tx.hash,
                blockNumber: receipt.blockNumber,
                batchSize: requests.length,
                gasUsed: receipt.gasUsed.toString(),
                individualEstimate: individualEstimate.toString(),
                savingsPercent: savings,
                gasCostEth: effectiveGasPrice
                    ? ethers.formatEther(receipt.gasUsed * effectiveGasPrice)
                    : null,
                users: [...new Set(requests.map(req => req.from))]
            });
            if (this._gasHistory.length > this._maxHistorySize) {
                this._gasHistory.shift();
            }

            return {
                status: "executed",
                txHash: tx.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                batchSize: requests.length,
                gasCostEth: effectiveGasPrice
                    ? ethers.formatEther(receipt.gasUsed * effectiveGasPrice)
                    : null
            };

        } catch (error) {
            console.error("Batch execution failed:", error.message);

            this._retryCount++;

            if (this._retryCount <= this.maxRetries) {
                console.log(`Retry ${this._retryCount}/${this.maxRetries}: re-queuing ${requests.length} requests`);
                // Re-queue, but they'll be re-verified on next flush
                this.pendingRequests = [...requests, ...this.pendingRequests];
                this.pendingSignatures = [...signatures, ...this.pendingSignatures];
                for (const req of requests) {
                    this._seenKeys.add(this._dedupKey(req));
                }
            } else {
                console.error(`Max retries (${this.maxRetries}) exceeded. Discarding ${requests.length} requests.`);
                this._retryCount = 0;
            }

            throw error;
        }
    }

    /**
     * Claim gas reimbursement from the GasSponsor contract.
     * Uses estimateReimbursement() pre-check before claiming.
     */
    async claimReimbursement(gasCost, users) {
        try {
            // Pre-check: will the claim succeed?
            const relayerAddress = await this.wallet.getAddress();
            const [reimburseAmount, wouldSucceed] = await this.gasSponsor.estimateReimbursement(
                gasCost, relayerAddress, users
            );

            if (!wouldSucceed || reimburseAmount === 0n) {
                console.log("Reimbursement pre-check failed, skipping claim");
                return;
            }

            const claimTx = await this.gasSponsor.claim(gasCost, users);
            await claimTx.wait();
            console.log(`Reimbursed: ${ethers.formatEther(reimburseAmount)} ETH`);

        } catch (error) {
            console.error("Reimbursement failed:", error.message);
        }
    }

    /**
     * Start automatic batch flushing at regular intervals.
     */
    startAutoFlush() {
        console.log(`Relayer started. Flushing every ${this.batchIntervalMs / 1000}s`);
        console.log(`Batch size: min=${this.minBatchSize}, max=${this.maxBatchSize}`);
        console.log(`Max retries: ${this.maxRetries}`);

        this.interval = setInterval(async () => {
            try {
                if (this.pendingRequests.length > 0) {
                    await this.flushBatch();
                }
            } catch (error) {
                // Don't crash the interval on errors
                console.error("Auto-flush error:", error.message);
            }
        }, this.batchIntervalMs);
    }

    /**
     * Force flush regardless of min batch size (useful for shutdown).
     */
    async forceFlush() {
        const savedMin = this.minBatchSize;
        this.minBatchSize = 1;
        try {
            return await this.flushBatch();
        } finally {
            this.minBatchSize = savedMin;
        }
    }

    /**
     * Stop the auto-flush interval.
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            console.log("Relayer stopped.");
        }
    }

    /**
     * Get current queue status.
     */
    getStatus() {
        return {
            queueSize: this.pendingRequests.length,
            minBatchSize: this.minBatchSize,
            maxBatchSize: this.maxBatchSize,
            retryCount: this._retryCount
        };
    }

    /**
     * Get gas usage history for analytics.
     * Returns aggregate stats + recent batch records.
     */
    getGasStats() {
        if (this._gasHistory.length === 0) {
            return {
                totalBatches: 0,
                totalTransactions: 0,
                totalGasSaved: "0",
                averageSavingsPercent: 0,
                history: []
            };
        }

        let totalTx = 0;
        let totalGasUsed = 0n;
        let totalIndividualEstimate = 0n;
        let totalSavingsPercent = 0;

        for (const entry of this._gasHistory) {
            totalTx += entry.batchSize;
            totalGasUsed += BigInt(entry.gasUsed);
            totalIndividualEstimate += BigInt(entry.individualEstimate);
            totalSavingsPercent += entry.savingsPercent;
        }

        const totalGasSaved = totalIndividualEstimate > totalGasUsed
            ? (totalIndividualEstimate - totalGasUsed).toString()
            : "0";

        return {
            totalBatches: this._gasHistory.length,
            totalTransactions: totalTx,
            totalGasUsed: totalGasUsed.toString(),
            totalGasSaved,
            averageSavingsPercent: Math.round(totalSavingsPercent / this._gasHistory.length),
            history: this._gasHistory.slice(-20) // Last 20 entries
        };
    }

    /**
     * Get the current on-chain nonce for a user.
     * Useful for the frontend to sync before signing.
     */
    async getNonceForUser(userAddress) {
        return Number(await this.batchExecutor.getNonce(userAddress));
    }
}

module.exports = { Relayer };
