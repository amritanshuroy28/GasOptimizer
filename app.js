// ═══════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════

// Defaults – overwritten by /api/config on page load
const CONFIG = {
    chainId: 11155111,  // Sepolia
    chainName: "Sepolia",
    rpcUrl: "https://rpc.sepolia.org",
    blockExplorer: "https://sepolia.etherscan.io",
    batchExecutorAddress: "",
    sampleTokenAddress: "",
    gasSponsorAddress: "",
};

// Fetch live contract addresses from the server so we stay in sync
// with the latest deployment without touching this file.
async function loadConfig() {
    try {
        const resp = await fetch("/api/config");
        const data = await resp.json();
        if (data.batchExecutorAddress) CONFIG.batchExecutorAddress = data.batchExecutorAddress;
        if (data.sampleTokenAddress)  CONFIG.sampleTokenAddress  = data.sampleTokenAddress;
        if (data.gasSponsorAddress)   CONFIG.gasSponsorAddress   = data.gasSponsorAddress;
        if (data.rpcUrl)              CONFIG.rpcUrl              = data.rpcUrl;
        if (data.chainId)             CONFIG.chainId             = data.chainId;
        if (data.chainName)           CONFIG.chainName           = data.chainName;
        if (data.blockExplorer)       CONFIG.blockExplorer       = data.blockExplorer;
        console.log("[Config] Loaded contract addresses from server");
    } catch (err) {
        console.warn("[Config] Could not fetch /api/config, using defaults", err);
    }
}

// ═══════════════════════════════════════════════════════════════
//  ABIs
// ═══════════════════════════════════════════════════════════════

const BATCH_EXECUTOR_ABI = [
    "function executeBatch(tuple(address from, address to, uint256 value, uint256 gas, uint256 nonce, uint256 deadline, bytes data)[] requests, bytes[] signatures) external payable returns (bool[])",
    "function verify(tuple(address from, address to, uint256 value, uint256 gas, uint256 nonce, uint256 deadline, bytes data) req, bytes signature) external view returns (bool)",
    "function getNonce(address from) external view returns (uint256)",
    "function incrementNonce() external"
];

const TOKEN_ABI = [
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)",
    "function decimals() external view returns (uint8)",
    "function symbol() external view returns (string)"
];

// ═══════════════════════════════════════════════════════════════
//  EIP-712 TYPES
// ═══════════════════════════════════════════════════════════════

// Built lazily after CONFIG is loaded
function getEIP712Domain() {
    return {
        name: "BatchExecutor",
        version: "1",
        chainId: CONFIG.chainId,
        verifyingContract: CONFIG.batchExecutorAddress
    };
}

const FORWARD_REQUEST_TYPES = {
    ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "data", type: "bytes" }
    ]
};

// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════

let provider = null;
let signer = null;
let userAddress = null;
let batchExecutor = null;
let tokenContract = null;
let currentNonce = 0;
let actions = [];
let actionId = 0;

// ═══════════════════════════════════════════════════════════════
//  WALLET CONNECTION
// ═══════════════════════════════════════════════════════════════

function toggleWallet() {
    if (userAddress) {
        disconnectWallet();
    } else {
        connectWallet();
    }
}

async function connectWallet() {
    if (!window.ethereum) {
        log("error", "MetaMask not detected. Please install MetaMask.");
        return;
    }

    try {
        log("info", "Requesting wallet connection...");

        provider = new ethers.BrowserProvider(window.ethereum);
        await provider.send("eth_requestAccounts", []);
        signer = await provider.getSigner();
        userAddress = await signer.getAddress();

        // Verify we're on the correct network
        const network = await provider.getNetwork();
        const detectedChainId = Number(network.chainId);

        if (detectedChainId !== CONFIG.chainId) {
            log("warn", `Wrong network (chain ${detectedChainId}). Switching to ${CONFIG.chainName} (chain ${CONFIG.chainId})...`);
            try {
                await window.ethereum.request({
                    method: "wallet_switchEthereumChain",
                    params: [{ chainId: "0x" + CONFIG.chainId.toString(16) }]
                });
            } catch (switchErr) {
                // Chain not added to MetaMask – try adding it
                if (switchErr.code === 4902) {
                    try {
                        await window.ethereum.request({
                            method: "wallet_addEthereumChain",
                            params: [{
                                chainId: "0x" + CONFIG.chainId.toString(16),
                                chainName: CONFIG.chainName,
                                rpcUrls: [CONFIG.rpcUrl],
                                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                                blockExplorerUrls: CONFIG.blockExplorer ? [CONFIG.blockExplorer] : []
                            }]
                        });
                    } catch (addErr) {
                        log("error", `Failed to add ${CONFIG.chainName} network to MetaMask. Please add it manually (RPC: ${CONFIG.rpcUrl}, Chain ID: ${CONFIG.chainId}).`);
                        return;
                    }
                } else {
                    log("error", `Failed to switch network. Please switch to ${CONFIG.chainName} (Chain ID ${CONFIG.chainId}) manually in MetaMask.`);
                    return;
                }
            }
            // Re-initialize provider after chain switch
            provider = new ethers.BrowserProvider(window.ethereum);
            signer = await provider.getSigner();
            userAddress = await signer.getAddress();
        }

        log("info", `Connected to chain ${CONFIG.chainId}`);

        // Initialize contracts
        batchExecutor = new ethers.Contract(CONFIG.batchExecutorAddress, BATCH_EXECUTOR_ABI, signer);
        tokenContract = new ethers.Contract(CONFIG.sampleTokenAddress, TOKEN_ABI, signer);

        // Update UI
        const short = userAddress.slice(0, 6) + "..." + userAddress.slice(-4);
        const btn = document.getElementById("connectBtn");
        btn.textContent = short;
        btn.classList.add("connected");
        btn.title = "Click to disconnect";
        document.getElementById("walletStatus").textContent = short;

        setStep(2);
        log("success", `Connected: ${short}`);

        // Fetch nonce and balance
        await refreshStatus();

    } catch (err) {
        log("error", `Connection failed: ${err.message}`);
    }
}

function disconnectWallet() {
    // Reset state
    provider = null;
    signer = null;
    userAddress = null;
    batchExecutor = null;
    tokenContract = null;
    currentNonce = 0;
    actions = [];
    actionId = 0;

    // Reset UI
    const btn = document.getElementById("connectBtn");
    btn.textContent = "Connect Wallet";
    btn.classList.remove("connected");
    btn.title = "";
    document.getElementById("walletStatus").textContent = "Not connected";
    document.getElementById("nonceStatus").textContent = "0";
    document.getElementById("balanceStatus").textContent = "—";

    // Clear action list
    const actionList = document.getElementById("actionList");
    if (actionList) actionList.innerHTML = "";

    setStep(1);
    log("info", "Wallet disconnected.");
}

async function refreshStatus() {
    try {
        // Sync nonce from contract — also cross-check with server
        currentNonce = Number(await batchExecutor.getNonce(userAddress));
        document.getElementById("nonceStatus").textContent = currentNonce;

        // Cross-check nonce with relayer server for consistency
        try {
            const resp = await fetch(`/api/nonce/${userAddress}`);
            const data = await resp.json();
            if (data.nonce !== undefined && data.nonce !== currentNonce) {
                log("warn", `Nonce mismatch: contract=${currentNonce}, server=${data.nonce}. Using contract value.`);
            }
        } catch (_) { /* server may be down — contract is source of truth */ }

        const balance = await tokenContract.balanceOf(userAddress);
        const decimals = await tokenContract.decimals();
        const symbol = await tokenContract.symbol();
        const formatted = ethers.formatUnits(balance, decimals);
        document.getElementById("balanceStatus").textContent = `${parseFloat(formatted).toLocaleString()} ${symbol}`;
    } catch (err) {
        document.getElementById("nonceStatus").textContent = "0";
        document.getElementById("balanceStatus").textContent = "—";
        log("warn", "Could not read contracts. Are they deployed?");
    }
}

/**
 * Claim test tokens from the faucet.
 * Sends a request to /api/faucet to receive SMPL tokens for testing.
 */
async function claimFaucet() {
    if (!userAddress) {
        log("warn", "Connect your wallet first");
        return;
    }

    const btn = document.getElementById("faucetBtn");
    btn.disabled = true;
    btn.textContent = "Claiming...";

    try {
        const resp = await fetch("/api/faucet", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: userAddress })
        });

        const data = await resp.json();

        if (!resp.ok) {
            throw new Error(data.error || "Faucet request failed");
        }

        log("success", `Received ${data.amount} — tx: ${data.txHash}`);
        await refreshStatus();
    } catch (err) {
        log("error", `Faucet error: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = "Get Test Tokens";
    }
}

/**
 * Skip the user's current nonce on-chain.
 * Used to unblock the queue when a request is stuck (e.g. expired deadline).
 */
async function skipNonce() {
    if (!signer || !batchExecutor) {
        log("error", "Connect your wallet first.");
        return;
    }
    try {
        log("info", `Skipping nonce ${currentNonce}...`);
        const tx = await batchExecutor.incrementNonce();
        await tx.wait();
        log("success", `Nonce skipped. New nonce: ${currentNonce + 1}`);
        await refreshStatus();
    } catch (err) {
        log("error", `Failed to skip nonce: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════
//  ACTION BUILDER
// ═══════════════════════════════════════════════════════════════

function addAction() {
    actionId++;
    actions.push({ id: actionId, to: "", amount: "" });
    renderActions();
    updateGasEstimate();
    setStep(2);
}

function removeAction(id) {
    actions = actions.filter(a => a.id !== id);
    renderActions();
    updateGasEstimate();
}

function updateAction(id, field, value) {
    const action = actions.find(a => a.id === id);
    if (action) action[field] = value;
    updateGasEstimate();
}

function renderActions() {
    const list = document.getElementById("actionList");
    const count = document.getElementById("actionCount");
    const pending = document.getElementById("pendingStatus");

    if (actions.length === 0) {
        list.innerHTML = '<div class="empty-state">Add your first transfer to get started</div>';
        count.textContent = "0 actions";
        pending.textContent = "0";
        document.getElementById("executeBtn").disabled = true;
        return;
    }

    list.innerHTML = actions.map((a, idx) => `
        <div class="action-item">
            <div class="action-num">${idx + 1}</div>
            <input class="action-input" 
                   type="text" 
                   placeholder="Recipient address (0x...)" 
                   value="${a.to}"
                   oninput="updateAction(${a.id}, 'to', this.value)" />
            <input class="action-input" 
                   type="text" 
                   placeholder="Amount (tokens)" 
                   value="${a.amount}"
                   oninput="updateAction(${a.id}, 'amount', this.value)" />
            <button class="remove-btn" onclick="removeAction(${a.id})">×</button>
        </div>
    `).join("");

    count.textContent = `${actions.length} action${actions.length !== 1 ? 's' : ''}`;
    pending.textContent = actions.length;
    const execBtn = document.getElementById("executeBtn");
    execBtn.disabled = !userAddress || actions.length === 0;
    execBtn.innerHTML = actions.length <= 1 ? "Send Transfer" : "Sign & Relay Batch";

    // Auto-scroll to the latest action
    requestAnimationFrame(() => list.scrollTop = list.scrollHeight);
}

function updateGasEstimate() {
    const n = actions.length;
    if (n === 0) {
        document.getElementById("gasOld").textContent = "—";
        document.getElementById("gasNew").textContent = "—";
        document.getElementById("gasSaving").style.display = "none";
        return;
    }

    const savingEl = document.getElementById("gasSaving");

    if (n === 1) {
        // Single action: direct transfer, no batching overhead
        const directGas = 58008;
        document.getElementById("gasOld").textContent = `${directGas.toLocaleString()} gas`;
        document.getElementById("gasNew").textContent = `${directGas.toLocaleString()} gas (direct)`;
        savingEl.style.display = "none";
        return;
    }

    const individualGas = n * 58008;
    // Measured formula: batch cost = 76314 (fixed) + n * 11590 (per request)
    // Derived from Foundry gas benchmarks (batch 2/5/10)
    const batchedGas = 76314 + n * 11590;

    document.getElementById("gasOld").textContent = `${individualGas.toLocaleString()} gas`;
    document.getElementById("gasNew").textContent = `${batchedGas.toLocaleString()} gas`;

    const savingPercent = Math.round(((individualGas - batchedGas) / individualGas) * 100);
    savingEl.textContent = `−${savingPercent}%`;
    savingEl.style.display = "inline";
}

// ═══════════════════════════════════════════════════════════════
//  SIGN & EXECUTE
// ═══════════════════════════════════════════════════════════════

async function executeBatch() {
    if (!signer || actions.length === 0) return;

    const btn = document.getElementById("executeBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Signing...';

    try {
        const validActions = [];
        const tokenIface = new ethers.Interface(TOKEN_ABI);

        for (let i = 0; i < actions.length; i++) {
            const a = actions[i];
            if (!ethers.isAddress(a.to)) {
                log("error", `Action ${i + 1}: Invalid address`);
                resetBtn();
                return;
            }
            if (!a.amount || isNaN(a.amount) || parseFloat(a.amount) <= 0) {
                log("error", `Action ${i + 1}: Invalid amount`);
                resetBtn();
                return;
            }
            validActions.push({
                to: CONFIG.sampleTokenAddress,
                recipient: a.to,
                amount: ethers.parseUnits(a.amount, 18),
                data: tokenIface.encodeFunctionData("transfer", [
                    a.to,
                    ethers.parseUnits(a.amount, 18)
                ]),
                gasLimit: 200000,
                value: 0
            });
        }

        // ── Single action: skip batching, send a direct transfer ──
        if (validActions.length === 1) {
            setStep(3);
            log("info", "Single action — sending direct transfer (no batch overhead)...");

            setStep(4);
            btn.innerHTML = '<span class="spinner"></span>Sending...';

            const tx = await tokenContract.transfer(
                validActions[0].recipient,
                validActions[0].amount
            );

            const txHash = tx.hash;
            log("info", `Tx submitted: ${txHash.slice(0, 14)}...`);
            log("info", "Waiting for confirmation...");

            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed;

            log("success", `✓ Direct transfer confirmed in block ${receipt.blockNumber}`);
            log("success", `Gas used: ${gasUsed.toString()} (direct call)`);

            await refreshStatus();
            actions = [];
            renderActions();

            for (let i = 1; i <= 4; i++) {
                document.getElementById(`step${i}`).className = "step done";
            }

            resetBtn();
            return;
        }

        // ── Multiple actions: use batch pathway ──
        setStep(3);
        log("info", `Preparing ${validActions.length} actions for signing...`);

        const requests = [];
        const signatures = [];

        for (let i = 0; i < validActions.length; i++) {
            const action = validActions[i];
            const request = {
                from: userAddress,
                to: action.to,
                value: action.value,
                gas: action.gasLimit,
                nonce: currentNonce + i,
                deadline: Math.floor(Date.now() / 1000) + 300, // 5 min expiry
                data: action.data
            };

            log("info", `Signing action ${i + 1}/${validActions.length} (nonce: ${currentNonce + i})...`);
            btn.innerHTML = `<span class="spinner"></span>Sign ${i + 1}/${validActions.length}`;

            const signature = await signer.signTypedData(
                getEIP712Domain(),
                FORWARD_REQUEST_TYPES,
                request
            );

            requests.push(request);
            signatures.push(signature);
            log("success", `Action ${i + 1} signed ✓`);
        }

        setStep(4);
        btn.innerHTML = '<span class="spinner"></span>Relaying...';
        log("info", "Submitting batch to BatchExecutor...");

        // Build a fully-specified raw transaction so MetaMask cannot
        // override the gas parameters with its own (higher) estimates.
        // By supplying every field via eth_sendTransaction, MetaMask
        // treats these as the authoritative values instead of running
        // its own gas estimation pass.
        const userAddr = await signer.getAddress();
        const iface = batchExecutor.interface;
        const txData = iface.encodeFunctionData("executeBatch", [requests, signatures]);

        const [estimatedGas, feeData, nonce] = await Promise.all([
            provider.estimateGas({
                from: userAddr,
                to: CONFIG.batchExecutorAddress,
                data: txData,
            }),
            provider.getFeeData(),
            provider.getTransactionCount(userAddr, "pending"),
        ]);

        const gasLimit = estimatedGas * 130n / 100n; // 30% buffer

        const txParams = {
            from: userAddr,
            to: CONFIG.batchExecutorAddress,
            data: txData,
            gas: "0x" + gasLimit.toString(16),
            nonce: "0x" + nonce.toString(16),
            chainId: "0x" + CONFIG.chainId.toString(16),
            type: "0x2", // EIP-1559
        };

        if (feeData.maxFeePerGas) {
            txParams.maxFeePerGas = "0x" + feeData.maxFeePerGas.toString(16);
            txParams.maxPriorityFeePerGas = "0x" + feeData.maxPriorityFeePerGas.toString(16);
        }

        const txHash = await provider.send("eth_sendTransaction", [txParams]);
        log("info", `Tx submitted: ${txHash.slice(0, 14)}...`);
        log("info", "Waiting for confirmation...");

        const receipt = await provider.waitForTransaction(txHash);
        const gasUsed = receipt.gasUsed;
        const individualEstimate = BigInt(actions.length) * 58008n;
        const savings = BigInt(individualEstimate) - BigInt(gasUsed);
        const savingsPercent = (100n * savings) / BigInt(individualEstimate);

        log("success", `✓ Batch executed in block ${receipt.blockNumber}`);
        log("success", `Gas used: ${gasUsed.toString()} (actual on-chain)`);
        log("success", `Individual cost (est.): ${individualEstimate.toString()} gas`);
        log("success", `Saved: ${savings.toString()} gas (${savingsPercent}%)`);

        showSavings(Number(individualEstimate), Number(gasUsed));

        await refreshStatus();
        actions = [];
        renderActions();

        for (let i = 1; i <= 4; i++) {
            document.getElementById(`step${i}`).className = "step done";
        }

    } catch (err) {
        log("error", `Failed: ${err.message}`);
        if (err.code === "ACTION_REJECTED") {
            log("warn", "User rejected the signature request.");
            setStep(2);
        }
    }

    resetBtn();
}

function resetBtn() {
    const btn = document.getElementById("executeBtn");
    btn.innerHTML = actions.length <= 1 ? "Send Transfer" : "Sign & Relay Batch";
    btn.disabled = !userAddress || actions.length === 0;
}

// ═══════════════════════════════════════════════════════════════
//  GAS SAVINGS VISUALIZATION
// ═══════════════════════════════════════════════════════════════

function showSavings(individualGas, batchedGas) {
    const container = document.getElementById("savingsVisual");
    container.classList.add("visible");

    const maxGas = individualGas;
    const indPct = 100;
    const batchPct = (batchedGas / maxGas) * 100;
    const saving = Math.round(((individualGas - batchedGas) / individualGas) * 100);

    document.getElementById("individualGasLabel").textContent = `${individualGas.toLocaleString()} gas`;
    document.getElementById("batchedGasLabel").textContent = `${batchedGas.toLocaleString()} gas`;

    setTimeout(() => {
        document.getElementById("individualBar").style.width = `${indPct}%`;
    }, 100);
    setTimeout(() => {
        document.getElementById("batchedBar").style.width = `${batchPct}%`;
    }, 400);

    document.getElementById("savingsPct").textContent = `${saving}%`;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function setStep(num) {
    for (let i = 1; i <= 4; i++) {
        const el = document.getElementById(`step${i}`);
        if (i < num) el.className = "step done";
        else if (i === num) el.className = "step active";
        else el.className = "step";
    }
}

function log(type, message) {
    const body = document.getElementById("logBody");
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    const entry = document.createElement("div");
    entry.className = "log-entry";
    entry.innerHTML = `<span class="log-time">[${time}]</span><span class="log-${type}">${message}</span>`;
    body.appendChild(entry);
    body.scrollTop = body.scrollHeight;
}

function clearLog() {
    document.getElementById("logBody").innerHTML = "";
}

// ═══════════════════════════════════════════════════════════════
//  THEME SWITCHING
// ═══════════════════════════════════════════════════════════════

function initializeTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    setTheme(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    updateThemeToggleIcon(theme);
}

function updateThemeToggleIcon(theme) {
    const toggle = document.getElementById('themeToggle');
    if (theme === 'light') {
        toggle.textContent = '☀️';
        toggle.title = 'Switch to dark mode';
    } else {
        toggle.textContent = '🌙';
        toggle.title = 'Switch to light mode';
    }
}

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════

// Initialize theme on page load
initializeTheme();

// Load contract config from server before anything else
loadConfig();

if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", () => window.location.reload());
}
