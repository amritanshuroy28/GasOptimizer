# Gas Fee Optimizer & Batch Transaction System

> A complete decentralized application demonstrating gas optimization through **transaction batching**, **EIP-712 meta-transactions**, and **sponsorship pool mechanisms** on a local Ganache network.

**Built for [Web3Assam](https://www.web3assam.org/)** — Driving blockchain education and adoption across Northeast India.

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Solution Overview](#solution-overview)
- [System Architecture](#system-architecture)
- [Smart Contracts](#smart-contracts)
- [Meta-Transaction Support](#meta-transaction-support)
- [Gas Sponsorship Logic](#gas-sponsorship-logic)
- [Frontend Interface](#frontend-interface)
- [Gas Savings Analysis](#gas-savings-analysis)
- [Security Model](#security-model)
- [Setup & Deployment](#setup--deployment)
- [Testing & Validation](#testing--validation)
- [Assumptions & Limitations](#assumptions--limitations)
- [File Structure](#file-structure)
- [References](#references)

---

## Problem Statement

Ethereum transactions require users to pay gas fees for every on-chain action. In applications with frequent or multi-step interactions, this creates:

- **High costs** — Each transaction carries a 21,000 gas base overhead
- **Poor UX** — Users must approve multiple MetaMask popups per workflow
- **Onboarding friction** — New users must acquire native ETH before using any dApp

This project addresses these issues by building a **Gas Fee Optimizer and Batch Transaction System** that combines:

1. **Transaction Batching** — Amortize the 21,000 base gas cost across N operations
2. **Meta-Transactions** — Users sign off-chain; relayers execute on-chain
3. **Gas Sponsorship** — Optional full/partial subsidization of gas fees

---

## Solution Overview

```
┌──────────────┐  EIP-712 Sign  ┌──────────────┐  Single TX    ┌─────────────────┐
│  User Wallet │───(no gas)────▶│   Relayer    │──(batched)──▶│  BatchExecutor  │
│  (MetaMask)  │                │   Server     │              │  (Smart Contract)│
└──────────────┘                └──────┬───────┘              └────────┬────────┘
                                       │ Reimburse                     │ Execute
                                       ▼                               ▼
                                ┌──────────────┐              ┌─────────────────┐
                                │  GasSponsor  │              │  SampleToken    │
                                │  (Pool)      │              │  (ERC-20)       │
                                └──────────────┘              └─────────────────┘
```

**User pays: 0 gas.** The relayer handles execution, optionally reimbursed by the sponsor pool.

---

## System Architecture

> Full architecture details: [`ARCHITECTURE.md`](ARCHITECTURE.md)

### Core Components

| Component | Type | Role |
|-----------|------|------|
| **BatchExecutor** | Solidity Contract | Verifies EIP-712 signatures, tracks nonces, enforces deadlines, executes batched calls |
| **GasSponsor** | Solidity Contract | Manages sponsorship pool with 6-layer constraint system |
| **SampleToken** | Solidity Contract | Meta-tx-aware ERC-20 (trusted forwarder pattern) |
| **Relayer** | Node.js Server | Queues signed requests, auto-flushes batches on timer |
| **Frontend** | HTML/JS | Wallet connection, action builder, EIP-712 signing UI |

### Design Patterns

- **Trusted Forwarder (ERC-2771)** — BatchExecutor appends real sender to calldata
- **EIP-712 Structured Data** — Human-readable, domain-bound signatures
- **Nonce-Based Replay Protection** — Sequential per-user nonces
- **Queue-and-Flush** — Time/size-triggered batch submission
- **Defense-in-Depth Sponsorship** — 6 independent constraint layers

### Transaction Flow

1. **User connects** wallet (MetaMask on Ganache)
2. **User builds** N token transfer actions in the UI
3. **User signs** each ForwardRequest via EIP-712 (no gas)
4. **Relayer receives** signed requests via `POST /api/relay`
5. **Relayer batches** requests and calls `executeBatch()` (one TX)
6. **BatchExecutor verifies** each signature, checks nonces, executes calls
7. **GasSponsor reimburses** relayer (if funded & within limits)


![WhatsApp Image 2026-03-09 at 7 11 45 PM](https://github.com/user-attachments/assets/1645ed72-2b95-4148-b364-8430652edda3)


---

## Smart Contracts

### BatchExecutor.sol ([source](contracts/BatchExecutor.sol))

The core contract implementing batched meta-transaction execution.

**Key Features:**
- EIP-712 domain separator (chain + contract bound)
- `verify(request, signature)` — On-chain signature verification
- `executeBatch(requests[], signatures[])` — Single-TX batch execution
- Sequential nonce tracking per user
- Gas-isolated sub-calls with configurable limits
- Sender identity propagation to target contracts

**ForwardRequest Struct:**
```solidity
struct ForwardRequest {
    address from;      // Original sender (user)
    address to;        // Target contract
    uint256 value;     // ETH to send (usually 0)
    uint256 gas;       // Gas limit for this sub-call
    uint256 nonce;     // User's sequential nonce (replay protection)
    uint256 deadline;  // Block timestamp after which request expires (0 = no expiry)
    bytes data;        // Encoded function call
}
```

### GasSponsor.sol ([source](contracts/GasSponsor.sol))

Manages gas fee subsidization with multi-layer constraints.

**Constraint Layers:**

| Layer | Constraint | Purpose |
|-------|-----------|---------|
| 1 | `maxPerClaim` | Caps maximum single reimbursement |
| 2 | `dailyLimitPerRelayer` | Prevents one relayer draining pool |
| 3 | `dailyLimitPerUser` | Prevents Sybil-style abuse |
| 4 | `globalDailyLimit` | Hard cap on total daily spending |
| 5 | Balance check | Cannot reimburse more than pool holds |
| 6 | Emergency pause | Owner can freeze all claims instantly |

**Sponsorship Modes:**
- **Full** — `maxPerClaim = 0.05 ETH` (onboarding campaigns)
- **Partial** — `maxPerClaim = 0.005 ETH` (sustainable operations)
- **None** — No GasSponsor deployed (relayer absorbs costs)

### SampleToken.sol ([source](contracts/SampleToken.sol))

Meta-transaction-aware ERC-20 implementing the trusted forwarder pattern.

- Overrides `_msgSender()` to extract real sender from forwarded calls
- Uses assembly for gas-efficient sender extraction
- Mints 1M tokens to deployer for testing

---

## Meta-Transaction Support

### How Off-Chain Signing Works

1. User's browser constructs a `ForwardRequest` struct
2. MetaMask's `eth_signTypedData_v4` is called with EIP-712 typed data
3. Wallet shows human-readable signing UI (no gas, no TX)
4. 65-byte signature is produced: `[r(32)][s(32)][v(1)]`
5. Signature is sent to relayer over HTTP

### On-Chain Execution

```solidity
// BatchExecutor verifies each signature (inlined for gas savings):

// 1. Deadline check (cheapest gate)
if (req.deadline != 0 && block.timestamp > req.deadline) { skip; }

// 2. EIP-712 hash + ecrecover
bytes32 structHash = keccak256(abi.encode(
    REQUEST_TYPEHASH,
    req.from, req.to, req.value, req.gas, req.nonce, req.deadline,
    keccak256(req.data)
));
bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
address signer = _recoverSigner(digest, signature);

// 3. Verify signer and nonce
if (signer != req.from || req.nonce != nonces[req.from]) { skip; }

// 4. Increment nonce BEFORE execution (reentrancy guard)
nonces[req.from] = currentNonce + 1;

// 5. Execute with sender identity appended (ERC-2771 pattern)
req.to.call{gas: req.gas, value: req.value}(abi.encodePacked(req.data, req.from));
```

### EIP-712 Domain

```javascript
{
    name: "BatchExecutor",
    version: "1",
    chainId: 1337,                  // Ganache
    verifyingContract: "0x..."      // Deployed BatchExecutor address
}
```

---

## Gas Sponsorship Logic

### Flow

```
Relayer executes batch → measures gas cost → calls GasSponsor.claim()
                                              │
                                              ├─ Cap: min(cost, maxPerClaim)
                                              ├─ Check relayer daily limit
                                              ├─ Check per-user daily limits
                                              ├─ Check global daily limit
                                              ├─ Check pool balance
                                              └─ Transfer ETH to relayer
```

### Pre-Flight Check

Relayers can call `estimateReimbursement()` (view function, no gas) before submitting a batch to verify the claim would succeed.

### Admin Controls

| Function | Access | Purpose |
|----------|--------|---------|
| `setRelayer(addr, bool)` | Owner | Whitelist/revoke relayers |
| `setLimits(...)` | Owner | Update all constraint parameters |
| `setPaused(bool)` | Owner | Emergency pause/unpause |
| `emergencyWithdraw()` | Owner | Pull all funds immediately |
| `transferOwnership(addr)` | Owner | Transfer admin control |

---

## Frontend Interface

The single-page application (`index.html`) provides:

1. **Wallet Connection** — MetaMask integration with network detection
2. **Status Dashboard** — Real-time nonce, balance, and pending action counts
3. **Action Builder** — Dynamic form to add/remove token transfers
4. **Gas Estimation** — Live comparison of individual vs. batched costs
5. **Signature Flow** — Step-by-step progress indicator
6. **Activity Log** — Real-time logging of all operations
7. **Savings Visualization** — Bar charts comparing gas costs
8. **Architecture Diagram** — Interactive system architecture visualization
9. **Gas Analysis Table** — Theoretical savings for various batch sizes
10. **Security Model** — Trust guarantees and safety properties
11. **Dark/Light Theme** — Persistent theme toggle

---

## Gas Savings Analysis

### Theoretical Model

Each Ethereum TX pays 21,000 gas base overhead. For a simple ERC-20 transfer (~31,000 gas execution):

$$\text{Individual Cost} = N \times (21{,}000 + 31{,}000) = N \times 52{,}000 \text{ gas}$$

$$\text{Batched Cost} = 21{,}000 + N \times (31{,}000 + 5{,}000_{\text{overhead}}) \approx 21{,}000 + N \times 15{,}600 \text{ gas}$$

$$\text{Savings} = (N-1) \times 21{,}000 - N \times 5{,}000$$

### Expected Results

| Batch Size | Individual | Batched | Savings |
|-----------|-----------|---------|---------|
| 2 | 104,000 | 65,000 | **37.5%** |
| 5 | 260,000 | 104,000 | **60.0%** |
| 10 | 520,000 | 182,000 | **65.0%** |
| 20 | 1,040,000 | 338,000 | **67.5%** |
| 50 | 2,600,000 | 806,000 | **69.0%** |

Savings asymptotically approach ~70% as batch size increases.

---

## Security Model

### Trust Assumptions

| Entity | Trust Boundary |
|--------|---------------|
| User | Trusts their wallet, EIP-712 standard. Does NOT trust relayer. |
| BatchExecutor | Trusts cryptographic signatures. Does NOT trust relayer identity. |
| Relayer | Trusts contract code. Validates all requests before queuing. |
| GasSponsor | Trusts whitelisted relayers and owner. |

### Attack Mitigations

| Attack Vector | Mitigation |
|--------------|-----------|
| Replay (same chain) | Sequential per-user nonces |
| Cross-chain replay | EIP-712 domain includes `chainId` |
| Cross-contract replay | EIP-712 domain includes `verifyingContract` |
| Relayer censorship | Users can execute directly on-chain |
| Gas griefing | Per-call gas limits in `ForwardRequest` |
| Sponsor pool drain | 6-layer constraint system |
| Signature forgery | ECDSA + EIP-712 typed data |
| Reentrancy | Nonce incremented before execution |
| Malicious relayer | Can only execute pre-signed actions |

---

## Setup & Deployment

### Prerequisites

- Node.js v18+
- [Ganache](https://trufflesuite.com/ganache/) running locally (default: `http://127.0.0.1:7545`)

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env`:

```env
GANACHE_RPC_URL=http://127.0.0.1:7545
DEPLOYER_PRIVATE_KEY=0xYOUR_GANACHE_PRIVATE_KEY
RELAYER_PRIVATE_KEY=0xYOUR_GANACHE_PRIVATE_KEY

# Auto-populated after deployment
BATCH_EXECUTOR_ADDRESS=0x...
SAMPLE_TOKEN_ADDRESS=0x...
GAS_SPONSOR_ADDRESS=0x...
RELAYER_ADDRESS=0x...
```

### 3. Compile Contracts

```bash
npm run compile
```

This uses Truffle to compile all Solidity contracts and generates artifacts in `build/contracts/`.

### 4. Deploy to Ganache

```bash
npm run deploy
```

Or to redeploy from scratch:

```bash
npm run deploy:reset
```

The Truffle migration scripts will:
1. Deploy BatchExecutor, SampleToken, and GasSponsor
2. Whitelist the relayer address in GasSponsor
3. Auto-update `.env` and `deployment.json` with new contract addresses

> **Note:** The frontend automatically fetches contract addresses from the server via `GET /api/config`, so no manual `index.html` editing is needed after deployment.

### 5. Start Server

```bash
npm start
```

Open http://localhost:3000

---

## Testing & Validation

### Run the Test Suite

```bash
npm test
```

This runs `test/gas-benchmark.js` on the Ganache network. **31 tests** across 9 categories:

1. **Signature Verification** — Valid EIP-712 signatures accepted; wrong-signer and wrong-nonce rejected
2. **Nonce Replay Protection & Recovery** — Replays blocked; `incrementNonce()` and `incrementNonceBy()` tested
3. **Request Deadline / Expiry** — Future deadlines accepted; past deadlines rejected; `deadline=0` (no expiry) works
4. **Batch Execution** — Single-request and multi-request (3-tx) batches execute correctly
5. **Gas Sponsorship** — Deposit, estimate, claim, cap enforcement, daily limits, and pause tested
6. **Multi-Size Gas Benchmark** — Actual gas measured for batch sizes 2, 5, 10 vs. direct transfers (same recipient)
6b. **Gas Benchmark — Different Recipients** — Actual gas measured for batch sizes 2, 5, 10 with different recipient addresses
7. **Failure Handling** — Empty batch, mismatched arrays, wrong nonce all revert correctly
8. **Partial Failure Resilience** — Expired requests are skipped without killing the entire batch

### Gas Benchmark Results (from tests)

| Batch Size | Total Gas | Gas/Tx | Savings vs Direct |
|-----------|-----------|--------|--------------------|
| 1 (direct) | 34,645 | 34,645 | — |
| 2 | 80,703 | 40,352 | -16% (overhead) |
| 5 | 135,738 | 27,148 | 22% |
| 10 | 227,439 | 22,744 | 34% |

---

## Assumptions & Limitations

### Assumptions

- Users have MetaMask installed and configured for Ganache (chainId 1337)
- Relayer has sufficient ETH (from Ganache accounts) to pay gas upfront
- GasSponsor pool is funded before reimbursement claims
- Network gas prices are within reasonable testnet ranges
- Single relayer model (no multi-relayer coordination)

### Limitations

1. ~~**Sequential nonces**~~ **Resolved** — `incrementNonce()` and `incrementNonceBy(count)` allow users to skip stuck nonces and unblock the queue
2. **Single relayer** — No multi-relayer coordination or failover (would need relayer registry and nonce reservation)
3. **Testnet only** — Not audited for mainnet deployment; uses simplified patterns
4. **Token-specific** — SampleToken must be deployed with BatchExecutor as trusted forwarder; existing tokens need wrapper contracts
5. ~~**Gas estimation**~~ **Improved** — Real gas tracking via `GET /api/gas-stats` endpoint; nonce sync via `GET /api/nonce/:address`; actual measurements in test suite
6. **MEV exposure** — Batch transactions on mainnet could be sandwich-attacked; needs private mempool or Flashbots integration
7. **Day-based resets** — GasSponsor daily limits use `block.timestamp / 1 days`, which can vary ±15 seconds

### Improvements Made

| Issue | Solution |
|-------|----------|
| Sequential nonces block queue | Added `incrementNonce()` and `incrementNonceBy(count)` to BatchExecutor; UI "Skip Nonce" button |
| No test suite | Created 31-test suite covering signatures, nonces, deadlines, batching, sponsorship, gas benchmarks (same & different recipients), and failure handling |
| Theoretical-only gas estimation | Added `GET /api/gas-stats` endpoint with real gas history, `GET /api/nonce/:address` for nonce sync |
| Frontend deadline bug | Fixed frontend ABI and ForwardRequest types to include `deadline` field (was missing, causing selector mismatch) |
| Stale nonces accepted by relayer | Added early nonce-sync check in relayer to reject requests with already-consumed nonces |
| No nonce recovery UI | Added "Skip Nonce" button in frontend status bar |

### Future Improvements

- Multi-relayer support with nonce reservations
- L2 deployment (Arbitrum, Optimism) for further gas savings
- Session keys for one-click batch signing
- ERC-4337 Account Abstraction integration
- Private mempool submission for MEV protection

---

## File Structure

```
├── contracts/                     # Solidity smart contracts
│   ├── BatchExecutor.sol          # Core: EIP-712 verification, batch execution, nonce recovery
│   ├── GasSponsor.sol             # Gas sponsorship pool with 6-layer constraints
│   └── SampleToken.sol            # Meta-tx-aware ERC-20 token
├── test/                          # Truffle test suite
│   └── gas-benchmark.js           # 31 tests: signatures, nonces, deadlines, batching, gas benchmarks
├── migrations/                    # Truffle migration scripts
│   ├── 1_initial_migration.js     # Required initial migration
│   └── 2_deploy_contracts.js      # Deploys all contracts, updates .env
├── build/contracts/               # Compiled contract ABIs (generated by Truffle)
├── server.js                      # Express server (frontend + API + config + gas-stats)
├── relayer.js                     # Batch queue, execution engine, gas history tracking
├── signer.js                      # EIP-712 signing utilities
├── index.html                     # Full frontend application
├── truffle-config.js              # Truffle configuration (Ganache network)
├── package.json                   # Dependencies and npm scripts
├── deployment.json                # Deployed contract addresses (auto-generated)
├── ARCHITECTURE.md                # Detailed system architecture design
├── DEPLOYMENT.md                  # Step-by-step deployment guide
├── SETUP.md                       # Setup verification checklist
└── README.md                      # This file
```

---

## Local Deployment (Ganache)

| Contract | Address |
|----------|--------|
| **BatchExecutor** | `0x2041C69a346e35c40d2b4E697A87aa2646350255` |
| **SampleToken** | `0xee8065cAeD152c60b380bE71A3107896055Ac526` |
| **GasSponsor** | `0x2D3D0F91812aa3C8C5fE7313D4d2Ee93eFa36544` |

**Network:** Ganache (chainId 1337, `http://127.0.0.1:7545`)
**Toolchain:** Truffle v5.11.5 + Solidity 0.8.24
**Local Server:** `npm start` → http://localhost:3000

---

## References

1. [EIP-712: Typed Structured Data Hashing and Signing](https://eips.ethereum.org/EIPS/eip-712)
2. [ERC-2771: Secure Protocol for Native Meta Transactions](https://eips.ethereum.org/EIPS/eip-2771)
3. [EIP-2028: Transaction Data Gas Cost Reduction](https://eips.ethereum.org/EIPS/eip-2028)
4. [ERC-4337: Account Abstraction Using Alt Mempool](https://eips.ethereum.org/EIPS/eip-4337)
5. [OpenZeppelin MinimalForwarder](https://docs.openzeppelin.com/contracts/4.x/api/metatx)
6. [Gas Station Network (GSN)](https://docs.opengsn.org/)
7. [Ethereum Yellow Paper — Transaction Execution](https://ethereum.github.io/yellowpaper/paper.pdf)
8. [Truffle Suite Documentation](https://trufflesuite.com/docs/truffle/)
9. [Ethers.js v6 Documentation](https://docs.ethers.org/v6/)
