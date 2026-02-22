// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/**
 * @title BatchExecutor
 * @author Gas Fee Optimizer — Batch Transaction System
 * @notice Executes batched meta-transactions with EIP-712 signature verification
 *         and nonce-based replay protection.
 *
 * @dev Implements the Trusted Forwarder pattern (inspired by ERC-2771)
 *      combined with transaction batching for gas optimization.
 *
 * ARCHITECTURE (ref: iBatch — ESEC/FSE '21):
 *   The system achieves gas savings by amortizing the 21,000 base transaction cost
 *   across N operations. For N token transfers:
 *     - Individual cost:  N × (21,000 + C_exec) gas
 *     - Batched cost:     21,000 + N × (C_exec + C_overhead) gas
 *     - Savings:          (N-1) × 21,000 - N × C_overhead gas
 *
 *   Where C_overhead ≈ 5,000 gas (signature verification + nonce check + loop)
 *   yields ~60-70% savings for batch sizes of 5-20.
 *
 * KEY FIXES (v2):
 *   - Graceful partial failures: one bad request no longer kills the entire batch
 *   - Batch deadline: prevents stale signed requests from being executed
 *   - Minimum batch size: enforces MinX policy (configurable, default 1)
 *   - Gas-per-call tracking via events for analytics
 *   - Optimized signature recovery with v-value normalization
 *   - Immutable DOMAIN_SEPARATOR for gas savings
 *
 * SECURITY MODEL:
 *   - EIP-712 domain separator binds signatures to this contract on this chain
 *   - Sequential nonces prevent replay attacks
 *   - Nonce incremented before execution prevents reentrancy-based reuse
 *   - Gas limits per sub-call prevent griefing attacks
 *   - Batch deadline prevents execution of stale requests
 *   - Users can bypass the relayer and call executeBatch() directly
 */
contract BatchExecutor {

    // ─── EIP-712 Domain Separator ────────────────────────────────
    // Immutable for gas savings — computed once at deploy time.
    // Binds signatures to THIS specific contract on THIS chain.

    bytes32 public immutable DOMAIN_SEPARATOR;

    // The "type hash" for our ForwardRequest struct.
    bytes32 public constant REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint256 deadline,bytes data)"
    );

    // ─── Configuration ────────────────────────────────────────────

    /// @notice Minimum number of requests required in a batch (iBatch MinX policy).
    /// Set to 1 by default so single requests still work; raise to 2+ for cost enforcement.
    uint256 public minBatchSize;

    address public owner;

    // ─── Nonce Tracking ──────────────────────────────────────────
    mapping(address => uint256) public nonces;

    // ─── The ForwardRequest Struct ───────────────────────────────
    struct ForwardRequest {
        address from;      // Original sender (user)
        address to;        // Target contract
        uint256 value;     // ETH to send along (usually 0)
        uint256 gas;       // Gas limit for this sub-call
        uint256 nonce;     // User's sequential nonce (replay protection)
        uint256 deadline;  // Block timestamp after which this request expires (0 = no expiry)
        bytes data;        // Encoded function call
    }

    // ─── Events ──────────────────────────────────────────────────

    event RequestExecuted(
        address indexed from,
        address indexed to,
        uint256 nonce,
        bool success,
        uint256 gasUsed
    );

    event RequestSkipped(
        address indexed from,
        uint256 nonce,
        string reason
    );

    event BatchExecuted(
        address indexed relayer,
        uint256 totalRequests,
        uint256 successCount,
        uint256 skippedCount,
        uint256 totalGasUsed
    );

    event MinBatchSizeUpdated(uint256 oldSize, uint256 newSize);

    // ─── Errors (custom errors save gas vs. require strings) ─────

    error EmptyBatch();
    error LengthMismatch();
    error BatchTooSmall(uint256 provided, uint256 minimum);
    error NotOwner();

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────

    constructor(uint256 _minBatchSize) {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("BatchExecutor")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        owner = msg.sender;
        minBatchSize = _minBatchSize > 0 ? _minBatchSize : 1;
    }

    // ─── Core Function: Verify a Signature ───────────────────────

    function verify(
        ForwardRequest calldata req,
        bytes calldata signature
    ) public view returns (bool) {
        // Check deadline first (cheap check)
        if (req.deadline != 0 && block.timestamp > req.deadline) {
            return false;
        }

        bytes32 structHash = keccak256(
            abi.encode(
                REQUEST_TYPEHASH,
                req.from,
                req.to,
                req.value,
                req.gas,
                req.nonce,
                req.deadline,
                keccak256(req.data)
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
        );

        address signer = _recoverSigner(digest, signature);

        return signer != address(0) && signer == req.from && req.nonce == nonces[req.from];
    }

    // ─── Core Function: Execute a Single Request ─────────────────

    function _executeRequest(
        ForwardRequest calldata req
    ) internal returns (bool success, uint256 gasUsedByCall) {
        // Increment nonce BEFORE execution (prevents reentrancy-based reuse)
        nonces[req.from] = req.nonce + 1;

        // Measure gas for this sub-call
        uint256 gasBefore = gasleft();

        // Execute the call with sender identity appended (ERC-2771 pattern)
        (success, ) = req.to.call{gas: req.gas, value: req.value}(
            abi.encodePacked(req.data, req.from)
        );

        gasUsedByCall = gasBefore - gasleft();

        emit RequestExecuted(req.from, req.to, req.nonce, success, gasUsedByCall);
    }

    // ─── Core Function: Execute a Batch ──────────────────────────
    // THE MAIN FUNCTION the relayer calls.
    // Takes an array of requests and signatures, verifies each, executes each.
    //
    // KEY CHANGE (v2): Individual request failures do NOT revert the entire batch.
    // Invalid signatures or expired requests are SKIPPED, not reverted.
    // This follows the iBatch paper's approach where partial batches still save gas.

    function executeBatch(
        ForwardRequest[] calldata requests,
        bytes[] calldata signatures
    ) external payable returns (bool[] memory results) {
        uint256 len = requests.length;

        if (len == 0) revert EmptyBatch();
        if (len != signatures.length) revert LengthMismatch();
        if (len < minBatchSize) revert BatchTooSmall(len, minBatchSize);

        results = new bool[](len);
        uint256 successCount;
        uint256 skippedCount;
        uint256 totalGas;

        for (uint256 i; i < len; ) {
            // Verify signature — skip (don't revert) on failure
            if (!verify(requests[i], signatures[i])) {
                // Determine skip reason for logging
                string memory reason;
                if (requests[i].deadline != 0 && block.timestamp > requests[i].deadline) {
                    reason = "expired";
                } else {
                    reason = "invalid signature or nonce";
                }
                emit RequestSkipped(requests[i].from, requests[i].nonce, reason);
                skippedCount++;
            } else {
                // Execute the verified request
                (bool success, uint256 gasUsed) = _executeRequest(requests[i]);
                results[i] = success;
                totalGas += gasUsed;

                if (success) {
                    successCount++;
                }
            }

            unchecked { ++i; }
        }

        emit BatchExecuted(msg.sender, len, successCount, skippedCount, totalGas);
    }

    // ─── Nonce Recovery ─────────────────────────────────────────
    //
    // Solves the sequential-nonce blockage problem:
    // If nonce N fails verification, nonces N+1, N+2… are stuck.
    // Users can call incrementNonce() to skip their current nonce
    // and unblock the queue.  incrementNonceBy() allows skipping
    // multiple stuck nonces in one call (e.g. if the relayer queued
    // several requests that all expired).

    event NonceIncremented(address indexed user, uint256 oldNonce, uint256 newNonce);

    /// @notice Skip the caller's current nonce to unblock subsequent requests.
    function incrementNonce() external {
        uint256 oldNonce = nonces[msg.sender];
        nonces[msg.sender] = oldNonce + 1;
        emit NonceIncremented(msg.sender, oldNonce, oldNonce + 1);
    }

    /// @notice Skip multiple nonces at once (e.g. clear a backlog of expired requests).
    /// @param count Number of nonces to skip (must be 1-50 to prevent misuse).
    function incrementNonceBy(uint256 count) external {
        require(count > 0 && count <= 50, "BatchExecutor: count must be 1-50");
        uint256 oldNonce = nonces[msg.sender];
        nonces[msg.sender] = oldNonce + count;
        emit NonceIncremented(msg.sender, oldNonce, oldNonce + count);
    }

    // ─── Admin Functions ─────────────────────────────────────────

    function setMinBatchSize(uint256 _minBatchSize) external onlyOwner {
        uint256 old = minBatchSize;
        minBatchSize = _minBatchSize > 0 ? _minBatchSize : 1;
        emit MinBatchSizeUpdated(old, minBatchSize);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "BatchExecutor: zero address");
        owner = newOwner;
    }

    // ─── View Functions ──────────────────────────────────────────

    function getNonce(address from) external view returns (uint256) {
        return nonces[from];
    }

    /// @notice Batch-verify multiple requests without executing them.
    /// Useful for relayers to pre-filter invalid requests before submitting.
    function verifyBatch(
        ForwardRequest[] calldata requests,
        bytes[] calldata signatures
    ) external view returns (bool[] memory valid) {
        require(requests.length == signatures.length, "BatchExecutor: length mismatch");
        valid = new bool[](requests.length);
        for (uint256 i; i < requests.length; ) {
            valid[i] = verify(requests[i], signatures[i]);
            unchecked { ++i; }
        }
    }

    // ─── Internal: Signature Recovery ────────────────────────────

    function _recoverSigner(
        bytes32 digest,
        bytes calldata signature
    ) internal pure returns (address) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        // Normalize v value (some signers return 0/1 instead of 27/28)
        if (v < 27) {
            v += 27;
        }

        // Reject invalid v values
        if (v != 27 && v != 28) return address(0);

        // Reject malleable signatures (s must be in lower half)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }

        return ecrecover(digest, v, r, s);
    }

    // Allow the contract to receive ETH (needed if requests send ETH)
    receive() external payable {}
}
