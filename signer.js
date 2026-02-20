// signer.js
// Browser-side utilities for building and signing ForwardRequests.
//
// KEY FIXES (v2):
//   - Added deadline support (request expiry)
//   - Added gas estimation helper
//   - Added request validation before signing
//   - Added batch signing with progress callback
//   - Updated ForwardRequest type to include deadline field

const EIP712_DOMAIN_TYPE = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" }
];

const FORWARD_REQUEST_TYPE = [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "data", type: "bytes" }
];

/**
 * Creates the EIP-712 domain data.
 * MUST match the smart contract's constructor.
 */
function getDomain(batchExecutorAddress, chainId) {
    return {
        name: "BatchExecutor",
        version: "1",
        chainId: chainId,
        verifyingContract: batchExecutorAddress
    };
}

/**
 * Build a ForwardRequest object.
 *
 * @param from       - User's wallet address
 * @param to         - Target contract to call
 * @param data       - Encoded function call
 * @param nonce      - User's current nonce from BatchExecutor
 * @param gasLimit   - Gas limit for this specific call (default 200000)
 * @param value      - ETH to send (default 0)
 * @param deadlineSec - Seconds from now until request expires (0 = no expiry)
 */
function buildRequest(from, to, data, nonce, gasLimit = 200000, value = 0, deadlineSec = 300) {
    // Validate inputs
    if (!from || !to || !data) {
        throw new Error("buildRequest: from, to, and data are required");
    }
    if (typeof nonce !== "number" || nonce < 0) {
        throw new Error("buildRequest: nonce must be a non-negative number");
    }
    if (gasLimit < 21000) {
        throw new Error("buildRequest: gasLimit must be at least 21000");
    }

    // Calculate deadline (0 means no expiry)
    const deadline = deadlineSec > 0
        ? Math.floor(Date.now() / 1000) + deadlineSec
        : 0;

    return {
        from: from,
        to: to,
        value: value,
        gas: gasLimit,
        nonce: nonce,
        deadline: deadline,
        data: data
    };
}

/**
 * Ask the user's wallet to sign a ForwardRequest using EIP-712.
 *
 * MetaMask will show a readable version of the request.
 * The user clicks "Sign" — no gas paid!
 *
 * @param provider  - ethers.js BrowserProvider (connected to MetaMask)
 * @param request   - The ForwardRequest object
 * @param batchExecutorAddress - Address of the deployed BatchExecutor
 * @param chainId   - Network chain ID
 * @returns         - The signature (65 bytes hex string)
 */
async function signRequest(provider, request, batchExecutorAddress, chainId) {
    const signer = await provider.getSigner();
    const domain = getDomain(batchExecutorAddress, chainId);

    const signature = await signer.signTypedData(
        domain,
        { ForwardRequest: FORWARD_REQUEST_TYPE },
        request
    );

    return signature;
}

/**
 * Helper: Encode a function call to use as the `data` field.
 */
function encodeFunctionCall(contractInterface, functionName, args) {
    return contractInterface.encodeFunctionData(functionName, args);
}

/**
 * Estimate gas for a target call (helps set appropriate gas limits).
 *
 * @param provider - ethers.js provider
 * @param from     - User's address
 * @param to       - Target contract address
 * @param data     - Encoded function call
 * @returns        - Estimated gas (with 50% buffer for meta-tx overhead)
 */
async function estimateCallGas(provider, from, to, data) {
    try {
        const estimate = await provider.estimateGas({
            from: from,
            to: to,
            data: data
        });
        // Add 50% buffer for meta-tx overhead (forwarder + sender extraction)
        return Math.ceil(Number(estimate) * 1.5);
    } catch (error) {
        console.warn("Gas estimation failed, using default:", error.message);
        return 200000;
    }
}

/**
 * FULL FLOW: Sign multiple requests for batching.
 *
 * @param provider              - ethers.js BrowserProvider
 * @param batchExecutorContract - ethers.Contract instance of BatchExecutor
 * @param batchExecutorAddress  - Address of BatchExecutor
 * @param chainId               - Network chain ID
 * @param actions               - Array of { to, data, gasLimit?, value?, deadlineSec? }
 * @param onProgress            - Optional callback: (index, total) => void
 * @returns                     - { requests, signatures }
 */
async function signBatchRequests(
    provider,
    batchExecutorContract,
    batchExecutorAddress,
    chainId,
    actions,
    onProgress = null
) {
    if (!actions || actions.length === 0) {
        throw new Error("signBatchRequests: actions array is empty");
    }

    const signer = await provider.getSigner();
    const userAddress = await signer.getAddress();

    // Get current nonce from the contract
    let currentNonce = Number(await batchExecutorContract.getNonce(userAddress));

    const requests = [];
    const signatures = [];

    for (let i = 0; i < actions.length; i++) {
        const action = actions[i];

        // Build the request with incrementing nonce
        const request = buildRequest(
            userAddress,
            action.to,
            action.data,
            currentNonce + i,
            action.gasLimit || 200000,
            action.value || 0,
            action.deadlineSec !== undefined ? action.deadlineSec : 300
        );

        // Sign it
        const signature = await signRequest(
            provider,
            request,
            batchExecutorAddress,
            chainId
        );

        requests.push(request);
        signatures.push(signature);

        // Report progress
        if (onProgress) {
            onProgress(i + 1, actions.length);
        }
    }

    return { requests, signatures };
}
