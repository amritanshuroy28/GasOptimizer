// test/gas-benchmark.js
// Comprehensive test suite for the Gas Optimizer — Batch Transaction System.
//
// Run with:  npm test  (or:  npx truffle test --network ganache)
//
// Covers:
//   1. Signature verification (valid / invalid / wrong signer)
//   2. Nonce replay protection & nonce recovery (incrementNonce)
//   3. Deadline (request expiry)
//   4. Single-request & multi-request batch execution
//   5. Gas sponsorship (deposit, estimate, claim, daily limits)
//   6. Multi-size gas benchmark (2, 5, 10 transfers)
//   7. Failure handling (empty batch, mismatched arrays, wrong nonce)
//   8. Partial-failure batches (one bad request doesn't kill the batch)

const BatchExecutor = artifacts.require("BatchExecutor");
const SampleToken = artifacts.require("SampleToken");
const GasSponsor = artifacts.require("GasSponsor");

const { expect } = require("chai");

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Build an EIP-712 domain separator that matches the contract.
 */
function eip712Domain(batchExecutorAddress, chainId) {
    return {
        name: "BatchExecutor",
        version: "1",
        chainId: chainId,
        verifyingContract: batchExecutorAddress,
    };
}

const FORWARD_REQUEST_TYPE = {
    ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "data", type: "bytes" },
    ],
};

/**
 * Sign a ForwardRequest using EIP-712 via eth_signTypedData_v4.
 * Works with Ganache accounts.
 */
async function signRequest(from, request, batchExecutorAddress, chainId) {
    const domain = eip712Domain(batchExecutorAddress, chainId);
    const msgParams = {
        types: {
            EIP712Domain: [
                { name: "name", type: "string" },
                { name: "version", type: "string" },
                { name: "chainId", type: "uint256" },
                { name: "verifyingContract", type: "address" },
            ],
            ...FORWARD_REQUEST_TYPE,
        },
        primaryType: "ForwardRequest",
        domain,
        message: {
            from: request.from,
            to: request.to,
            value: request.value.toString(),
            gas: request.gas.toString(),
            nonce: request.nonce.toString(),
            deadline: request.deadline.toString(),
            data: request.data,
        },
    };

    // Ganache expects the TypedData as an object (not a JSON string)
    const signature = await web3.currentProvider.request({
        method: "eth_signTypedData_v4",
        params: [from, msgParams],
    });
    return signature;
}

/**
 * Build a ForwardRequest object.
 */
function buildRequest(from, to, nonce, data, gas = 200000, value = 0, deadline = 0) {
    return { from, to, value, gas, nonce, deadline, data };
}

/**
 * Encode a SampleToken transfer call.
 */
function encodeTransfer(tokenContract, recipient, amount) {
    return tokenContract.contract.methods
        .transfer(recipient, amount)
        .encodeABI();
}

// ─── Test Suite ──────────────────────────────────────────────────

contract("Gas Optimizer — Full Test Suite", function (accounts) {
    const [deployer, user1, user2, user3, relayer] = accounts;

    let batchExecutor, sampleToken, gasSponsor;
    let chainId;

    const ONE_TOKEN = web3.utils.toWei("1", "ether"); // 1 token (18 decimals)
    const TEN_TOKENS = web3.utils.toWei("10", "ether");

    before(async function () {
        // Deploy contracts
        batchExecutor = await BatchExecutor.new(1, { from: deployer });
        sampleToken = await SampleToken.new(batchExecutor.address, { from: deployer });
        gasSponsor = await GasSponsor.new(
            web3.utils.toWei("0.05", "ether"),  // maxPerClaim
            web3.utils.toWei("1", "ether"),      // dailyLimitPerRelayer
            web3.utils.toWei("0.01", "ether"),   // dailyLimitPerUser
            web3.utils.toWei("5", "ether"),      // globalDailyLimit
            { from: deployer }
        );

        // Whitelist relayer
        await gasSponsor.setRelayer(relayer, true, { from: deployer });

        // Get chain ID
        chainId = await web3.eth.getChainId();

        // Fund user1 with tokens for testing transfers
        await sampleToken.transfer(user1, web3.utils.toWei("10000", "ether"), {
            from: deployer,
        });

        console.log("\n  ┌──────────────────────────────────────────────┐");
        console.log("  │         Gas Optimizer — Test Setup            │");
        console.log("  ├──────────────────────────────────────────────┤");
        console.log(`  │  Chain ID:       ${chainId}`);
        console.log(`  │  BatchExecutor:  ${batchExecutor.address.slice(0, 20)}...`);
        console.log(`  │  SampleToken:    ${sampleToken.address.slice(0, 20)}...`);
        console.log(`  │  GasSponsor:     ${gasSponsor.address.slice(0, 20)}...`);
        console.log(`  │  User1 tokens:   10,000 SMPL`);
        console.log("  └──────────────────────────────────────────────┘\n");
    });

    // ═════════════════════════════════════════════════════════════
    //  1. SIGNATURE VERIFICATION
    // ═════════════════════════════════════════════════════════════

    describe("1. Signature Verification", function () {
        it("should verify a valid EIP-712 signature", async function () {
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            const request = buildRequest(user1, sampleToken.address, 0, data);
            const sig = await signRequest(
                user1, request, batchExecutor.address, chainId
            );

            const isValid = await batchExecutor.verify(request, sig);
            expect(isValid).to.be.true;
        });

        it("should reject a signature from the wrong signer", async function () {
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            const request = buildRequest(user1, sampleToken.address, 0, data);

            // Sign as user2 but claim to be user1
            const sig = await signRequest(
                user2, request, batchExecutor.address, chainId
            );

            const isValid = await batchExecutor.verify(request, sig);
            expect(isValid).to.be.false;
        });

        it("should reject a signature with wrong nonce", async function () {
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            // Nonce 999 doesn't match the current nonce (0)
            const request = buildRequest(user1, sampleToken.address, 999, data);
            const sig = await signRequest(
                user1, request, batchExecutor.address, chainId
            );

            const isValid = await batchExecutor.verify(request, sig);
            expect(isValid).to.be.false;
        });
    });

    // ═════════════════════════════════════════════════════════════
    //  2. NONCE REPLAY PROTECTION & RECOVERY
    // ═════════════════════════════════════════════════════════════

    describe("2. Nonce Replay Protection & Recovery", function () {
        it("should increment nonce after successful execution", async function () {
            const nonceBefore = (await batchExecutor.getNonce(user1)).toNumber();

            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            const request = buildRequest(user1, sampleToken.address, nonceBefore, data);
            const sig = await signRequest(
                user1, request, batchExecutor.address, chainId
            );

            await batchExecutor.executeBatch([request], [sig], { from: relayer });

            const nonceAfter = (await batchExecutor.getNonce(user1)).toNumber();
            expect(nonceAfter).to.equal(nonceBefore + 1);
        });

        it("should reject replay of an already-executed request", async function () {
            const currentNonce = (await batchExecutor.getNonce(user1)).toNumber();
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            const request = buildRequest(user1, sampleToken.address, currentNonce, data);
            const sig = await signRequest(
                user1, request, batchExecutor.address, chainId
            );

            // Execute once
            await batchExecutor.executeBatch([request], [sig], { from: relayer });

            // The same request is now invalid (nonce already consumed)
            const isValid = await batchExecutor.verify(request, sig);
            expect(isValid).to.be.false;
        });

        it("should allow user to skip a stuck nonce via incrementNonce()", async function () {
            const nonceBefore = (await batchExecutor.getNonce(user1)).toNumber();

            const tx = await batchExecutor.incrementNonce({ from: user1 });

            // Check event
            const event = tx.logs.find(l => l.event === "NonceIncremented");
            expect(event).to.exist;
            expect(event.args.oldNonce.toNumber()).to.equal(nonceBefore);
            expect(event.args.newNonce.toNumber()).to.equal(nonceBefore + 1);

            const nonceAfter = (await batchExecutor.getNonce(user1)).toNumber();
            expect(nonceAfter).to.equal(nonceBefore + 1);
        });

        it("should allow user to skip multiple nonces via incrementNonceBy()", async function () {
            const nonceBefore = (await batchExecutor.getNonce(user1)).toNumber();

            await batchExecutor.incrementNonceBy(5, { from: user1 });

            const nonceAfter = (await batchExecutor.getNonce(user1)).toNumber();
            expect(nonceAfter).to.equal(nonceBefore + 5);
        });

        it("should reject incrementNonceBy with count > 50", async function () {
            try {
                await batchExecutor.incrementNonceBy(51, { from: user1 });
                assert.fail("Expected revert");
            } catch (err) {
                expect(err.message).to.include("count must be 1-50");
            }
        });
    });

    // ═════════════════════════════════════════════════════════════
    //  3. DEADLINE (REQUEST EXPIRY)
    // ═════════════════════════════════════════════════════════════

    describe("3. Request Deadline / Expiry", function () {
        it("should accept a request with deadline in the future", async function () {
            const currentNonce = (await batchExecutor.getNonce(user1)).toNumber();
            const futureDeadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            const request = buildRequest(user1, sampleToken.address, currentNonce, data, 200000, 0, futureDeadline);
            const sig = await signRequest(
                user1, request, batchExecutor.address, chainId
            );

            const isValid = await batchExecutor.verify(request, sig);
            expect(isValid).to.be.true;
        });

        it("should reject an expired request (deadline in the past)", async function () {
            const currentNonce = (await batchExecutor.getNonce(user1)).toNumber();
            const pastDeadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            const request = buildRequest(user1, sampleToken.address, currentNonce, data, 200000, 0, pastDeadline);
            const sig = await signRequest(
                user1, request, batchExecutor.address, chainId
            );

            const isValid = await batchExecutor.verify(request, sig);
            expect(isValid).to.be.false;
        });

        it("should accept a request with deadline = 0 (no expiry)", async function () {
            const currentNonce = (await batchExecutor.getNonce(user1)).toNumber();
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            const request = buildRequest(user1, sampleToken.address, currentNonce, data, 200000, 0, 0);
            const sig = await signRequest(
                user1, request, batchExecutor.address, chainId
            );

            const isValid = await batchExecutor.verify(request, sig);
            expect(isValid).to.be.true;

            // Execute it to consume the nonce
            await batchExecutor.executeBatch([request], [sig], { from: relayer });
        });
    });

    // ═════════════════════════════════════════════════════════════
    //  4. BATCH EXECUTION
    // ═════════════════════════════════════════════════════════════

    describe("4. Batch Execution", function () {
        it("should execute a single-request batch", async function () {
            const currentNonce = (await batchExecutor.getNonce(user1)).toNumber();
            const balBefore = await sampleToken.balanceOf(user2);

            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            const request = buildRequest(user1, sampleToken.address, currentNonce, data);
            const sig = await signRequest(
                user1, request, batchExecutor.address, chainId
            );

            const tx = await batchExecutor.executeBatch([request], [sig], { from: relayer });

            const balAfter = await sampleToken.balanceOf(user2);
            const transferred = web3.utils.toBN(balAfter).sub(web3.utils.toBN(balBefore));
            expect(transferred.toString()).to.equal(ONE_TOKEN);

            // Check BatchExecuted event
            const batchEvent = tx.logs.find(l => l.event === "BatchExecuted");
            expect(batchEvent).to.exist;
            expect(batchEvent.args.successCount.toNumber()).to.equal(1);
            expect(batchEvent.args.skippedCount.toNumber()).to.equal(0);
        });

        it("should execute a multi-request batch (3 transfers)", async function () {
            let currentNonce = (await batchExecutor.getNonce(user1)).toNumber();

            const requests = [];
            const signatures = [];

            for (let i = 0; i < 3; i++) {
                const data = encodeTransfer(sampleToken, user3, ONE_TOKEN);
                const request = buildRequest(
                    user1, sampleToken.address, currentNonce + i, data
                );
                const sig = await signRequest(
                    user1, request, batchExecutor.address, chainId
                );
                requests.push(request);
                signatures.push(sig);
            }

            const balBefore = await sampleToken.balanceOf(user3);
            const tx = await batchExecutor.executeBatch(requests, signatures, { from: relayer });
            const balAfter = await sampleToken.balanceOf(user3);

            const transferred = web3.utils.toBN(balAfter).sub(web3.utils.toBN(balBefore));
            expect(transferred.toString()).to.equal(web3.utils.toWei("3", "ether"));

            const batchEvent = tx.logs.find(l => l.event === "BatchExecuted");
            expect(batchEvent.args.totalRequests.toNumber()).to.equal(3);
            expect(batchEvent.args.successCount.toNumber()).to.equal(3);
        });
    });

    // ═════════════════════════════════════════════════════════════
    //  5. GAS SPONSORSHIP
    // ═════════════════════════════════════════════════════════════

    describe("5. Gas Sponsorship", function () {
        it("should accept ETH deposits", async function () {
            const depositAmount = web3.utils.toWei("1", "ether");
            await gasSponsor.deposit({ from: deployer, value: depositAmount });

            const balance = await gasSponsor.getBalance();
            expect(balance.toString()).to.equal(depositAmount);
        });

        it("should estimate reimbursement correctly", async function () {
            const amount = web3.utils.toWei("0.01", "ether");
            const result = await gasSponsor.estimateReimbursement(
                amount, relayer, [user1]
            );
            expect(result.wouldSucceed).to.be.true;
            expect(result.reimbursement.toString()).to.equal(amount);
        });

        it("should reimburse relayer for gas costs", async function () {
            const balBefore = web3.utils.toBN(await web3.eth.getBalance(relayer));
            const claimAmount = web3.utils.toWei("0.005", "ether");

            const tx = await gasSponsor.claim(claimAmount, [user1], { from: relayer });
            const gasUsed = web3.utils.toBN(tx.receipt.gasUsed);
            const gasPrice = web3.utils.toBN(
                (await web3.eth.getTransaction(tx.tx)).gasPrice
            );
            const gasCost = gasUsed.mul(gasPrice);

            const balAfter = web3.utils.toBN(await web3.eth.getBalance(relayer));
            const netGain = balAfter.sub(balBefore).add(gasCost);
            expect(netGain.toString()).to.equal(claimAmount);

            // Check Claimed event
            const event = tx.logs.find(l => l.event === "Claimed");
            expect(event).to.exist;
            expect(event.args.amount.toString()).to.equal(claimAmount);
        });

        it("should cap reimbursement at maxPerClaim", async function () {
            // Request 1 ETH — should be capped at maxPerClaim (0.05 ETH).
            // To pass per-user daily limit checks (0.01 ETH/user), we spread
            // across enough fresh users so each user's share is ≤ 0.01 ETH.
            const overCap = web3.utils.toWei("1", "ether"); // maxPerClaim is 0.05
            const manyUsers = accounts.slice(5, 10); // 5 fresh accounts

            const result = await gasSponsor.estimateReimbursement(
                overCap, relayer, manyUsers
            );
            expect(result.wouldSucceed).to.be.true;
            // Should be capped at 0.05 ETH (not the full 1 ETH)
            expect(
                web3.utils.fromWei(result.reimbursement.toString(), "ether")
            ).to.equal("0.05");
        });

        it("should track daily limits per user", async function () {
            const remaining = await gasSponsor.getUserDailyRemaining(user1);
            // user1 already claimed 0.005 ETH — daily limit is 0.01 ETH
            expect(
                Number(web3.utils.fromWei(remaining.toString(), "ether"))
            ).to.be.lessThan(0.01);
        });

        it("should reject claims when paused", async function () {
            await gasSponsor.setPaused(true, { from: deployer });

            try {
                await gasSponsor.claim(
                    web3.utils.toWei("0.001", "ether"),
                    [user1],
                    { from: relayer }
                );
                assert.fail("Expected revert");
            } catch (err) {
                expect(err.message).to.include("revert");
            }

            await gasSponsor.setPaused(false, { from: deployer });
        });
    });

    // ═════════════════════════════════════════════════════════════
    //  6. MULTI-SIZE GAS BENCHMARK
    // ═════════════════════════════════════════════════════════════

    describe("6. Gas Benchmark — Batch Size Comparison", function () {
        const benchmarkResults = [];

        async function measureBatch(batchSize) {
            // Fund user1 with enough tokens
            const needed = web3.utils.toWei((batchSize * 1).toString(), "ether");
            const currentBal = await sampleToken.balanceOf(user1);
            if (web3.utils.toBN(currentBal).lt(web3.utils.toBN(needed))) {
                await sampleToken.transfer(user1, web3.utils.toWei("50000", "ether"), {
                    from: deployer,
                });
            }

            let currentNonce = (await batchExecutor.getNonce(user1)).toNumber();
            const requests = [];
            const signatures = [];

            for (let i = 0; i < batchSize; i++) {
                const data = encodeTransfer(sampleToken, user3, ONE_TOKEN);
                const request = buildRequest(
                    user1, sampleToken.address, currentNonce + i, data
                );
                const sig = await signRequest(
                    user1, request, batchExecutor.address, chainId
                );
                requests.push(request);
                signatures.push(sig);
            }

            const tx = await batchExecutor.executeBatch(requests, signatures, {
                from: relayer,
            });

            return tx.receipt.gasUsed;
        }

        async function measureIndividual() {
            // Measure gas for a single direct token transfer (no batching)
            const tx = await sampleToken.transfer(user2, ONE_TOKEN, {
                from: user1,
            });
            return tx.receipt.gasUsed;
        }

        it("should measure single direct transfer gas (baseline)", async function () {
            const gasUsed = await measureIndividual();
            benchmarkResults.push({
                size: 1,
                type: "direct",
                gasUsed,
                perTx: gasUsed,
            });
            console.log(`      Single direct transfer: ${gasUsed} gas`);
        });

        for (const size of [2, 5, 10]) {
            it(`should measure batch of ${size} transfers`, async function () {
                const gasUsed = await measureBatch(size);
                const perTx = Math.ceil(gasUsed / size);
                benchmarkResults.push({ size, type: "batched", gasUsed, perTx });
                console.log(
                    `      Batch of ${size}: ${gasUsed} gas total, ${perTx} gas/tx`
                );
            });
        }

        after(function () {
            if (benchmarkResults.length === 0) return;

            const directGas = benchmarkResults.find((r) => r.type === "direct");
            if (!directGas) return;

            console.log("\n  ┌──────────────────────────────────────────────────────────────┐");
            console.log("  │                 GAS BENCHMARK RESULTS                        │");
            console.log("  ├──────────┬──────────────┬──────────────┬───────────────────── │");
            console.log("  │  Size    │  Total Gas   │  Gas/Tx      │  Savings vs Direct   │");
            console.log("  ├──────────┼──────────────┼──────────────┼───────────────────── │");

            for (const r of benchmarkResults.filter((r) => r.type === "batched")) {
                const individualCost = directGas.gasUsed * r.size;
                const savings = Math.round(
                    ((individualCost - r.gasUsed) / individualCost) * 100
                );
                console.log(
                    `  │  ${String(r.size).padEnd(6)}  │  ${String(r.gasUsed).padEnd(10)}  │  ${String(r.perTx).padEnd(10)}  │  ${savings}%`.padEnd(63) + "│"
                );
            }

            console.log("  └──────────┴──────────────┴──────────────┴───────────────────── ┘\n");
        });
    });

    // ═════════════════════════════════════════════════════════════
    //  7. FAILURE HANDLING
    // ═════════════════════════════════════════════════════════════

    describe("7. Failure Handling", function () {
        it("should revert on empty batch", async function () {
            try {
                await batchExecutor.executeBatch([], [], { from: relayer });
                assert.fail("Expected revert");
            } catch (err) {
                expect(err.message).to.include("revert");
            }
        });

        it("should revert on mismatched array lengths", async function () {
            const currentNonce = (await batchExecutor.getNonce(user1)).toNumber();
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);
            const request = buildRequest(user1, sampleToken.address, currentNonce, data);
            const sig = await signRequest(
                user1, request, batchExecutor.address, chainId
            );

            try {
                // 1 request, 2 signatures
                await batchExecutor.executeBatch([request], [sig, sig], {
                    from: relayer,
                });
                assert.fail("Expected revert");
            } catch (err) {
                expect(err.message).to.include("revert");
            }
        });

        it("should skip (not revert) a request with wrong nonce in a batch", async function () {
            const currentNonce = (await batchExecutor.getNonce(user1)).toNumber();
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);

            // First request: valid
            const req1 = buildRequest(user1, sampleToken.address, currentNonce, data);
            const sig1 = await signRequest(
                user1, req1, batchExecutor.address, chainId
            );

            // Second request: wrong nonce (should be currentNonce+1 but we use 999)
            const req2 = buildRequest(user1, sampleToken.address, 999, data);
            const sig2 = await signRequest(
                user1, req2, batchExecutor.address, chainId
            );

            const tx = await batchExecutor.executeBatch(
                [req1, req2],
                [sig1, sig2],
                { from: relayer }
            );

            const batchEvent = tx.logs.find((l) => l.event === "BatchExecuted");
            expect(batchEvent.args.successCount.toNumber()).to.equal(1);
            expect(batchEvent.args.skippedCount.toNumber()).to.equal(1);

            const skipEvent = tx.logs.find((l) => l.event === "RequestSkipped");
            expect(skipEvent).to.exist;
        });
    });

    // ═════════════════════════════════════════════════════════════
    //  8. PARTIAL-FAILURE BATCHES
    // ═════════════════════════════════════════════════════════════

    describe("8. Partial Failure Resilience", function () {
        it("should execute valid requests even when one has an expired deadline", async function () {
            let currentNonce = (await batchExecutor.getNonce(user1)).toNumber();
            const data = encodeTransfer(sampleToken, user2, ONE_TOKEN);

            // Request 1: valid (no deadline)
            const req1 = buildRequest(user1, sampleToken.address, currentNonce, data, 200000, 0, 0);
            const sig1 = await signRequest(
                user1, req1, batchExecutor.address, chainId
            );

            // Request 2: expired deadline — will be skipped
            const req2 = buildRequest(
                user1, sampleToken.address, currentNonce + 1, data, 200000, 0,
                1 // Unix timestamp 1 = far in the past
            );
            const sig2 = await signRequest(
                user1, req2, batchExecutor.address, chainId
            );

            const tx = await batchExecutor.executeBatch(
                [req1, req2],
                [sig1, sig2],
                { from: relayer }
            );

            const batchEvent = tx.logs.find((l) => l.event === "BatchExecuted");
            expect(batchEvent.args.successCount.toNumber()).to.equal(1);
            expect(batchEvent.args.skippedCount.toNumber()).to.equal(1);

            // The expired skip reason should be "expired"
            const skipEvent = tx.logs.find((l) => l.event === "RequestSkipped");
            expect(skipEvent).to.exist;
            expect(skipEvent.args.reason).to.equal("expired");
        });
    });
});
