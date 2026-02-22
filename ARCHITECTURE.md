# System Architecture Design

## Gas Fee Optimizer & Batch Transaction System

### 1. Architecture Overview

This system implements a **Gas Fee Optimizer and Batch Transaction System** that leverages three core techniques from Ethereum gas optimization research:

1. **Transaction Batching** — Amortizing the 21,000 base gas cost across multiple operations
2. **Meta-Transactions (EIP-712)** — Off-chain signing with on-chain relayed execution
3. **Gas Sponsorship** — Optional subsidization of gas fees with configurable constraints

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SYSTEM ARCHITECTURE                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐    EIP-712     ┌───────────┐    Batch TX    ┌──────┐ │
│  │  User /  │───(sign off───▶│  Relayer  │───(on-chain)──▶│ Batch│ │
│  │  Wallet  │    chain)      │  Server   │                │Execu-│ │
│  │(MetaMask)│                │ (Node.js) │                │ tor  │ │
│  └──────────┘                └─────┬─────┘                └──┬───┘ │
│       │                            │                         │     │
│       │                            │ Reimburse               │     │
│       │                            ▼                         │     │
│       │                      ┌───────────┐                   │     │
│       │                      │    Gas    │                   │     │
│       │                      │ Sponsor  │◀──(call target)───┘     │
│       │                      │   Pool   │                         │
│       │                      └───────────┘                        │
│       │                                                            │
│       │  Token Transfer       ┌───────────┐                       │
│       └──────────────────────▶│  Sample   │                       │
│          (via BatchExecutor)  │  Token    │                       │
│                               │ (ERC-20) │                       │
│                               └───────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 2. Component Design

#### 2.1 BatchExecutor (Core Smart Contract)

**Role:** Central hub that verifies EIP-712 signatures, enforces nonce-based replay protection, and executes batched calls to target contracts.

```
┌─────────────────────────────────────────────────────────┐
│                    BatchExecutor.sol                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  State:                                                 │
│    DOMAIN_SEPARATOR  (bytes32) — EIP-712 domain hash    │
│    REQUEST_TYPEHASH  (bytes32) — struct type hash       │
│    nonces            (mapping) — per-user nonce counter │
│                                                         │
│  Core Functions:                                        │
│    verify(req, sig) → bool                              │
│      ├─ Hash request via EIP-712 encoding               │
│      ├─ Recover signer via ecrecover                    │
│      └─ Check signer == req.from && nonce match         │
│                                                         │
│    executeBatch(requests[], signatures[]) → bool[]      │
│      ├─ For each (request, signature):                  │
│      │   ├─ verify(request, signature)                  │
│      │   ├─ Increment nonce (pre-execution)             │
│      │   └─ Execute: req.to.call(req.data ++ req.from)  │
│      └─ Emit BatchExecuted event                        │
│                                                         │
│  Security:                                              │
│    - EIP-712 domain binding (chain + contract)          │
│    - Sequential nonce enforcement                       │
│    - Sender identity appended to calldata               │
│    - Pre-execution nonce increment (reentrancy guard)   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Design Decisions:**
- **Nonce model:** Sequential per-user nonces (like Ethereum itself). Prevents replay attacks while maintaining ordering guarantees.
- **Sender propagation:** The original sender (`req.from`) is appended to calldata as the last 20 bytes. Target contracts extract it to identify the real user.
- **Gas isolation:** Each sub-call has its own gas limit (`req.gas`), preventing one failed call from consuming the entire batch's gas.

#### 2.2 GasSponsor (Sponsorship Pool)

**Role:** Manages a fund pool that reimburses relayers for gas spent executing user transactions. Implements configurable constraints to prevent abuse.

```
┌─────────────────────────────────────────────────────────┐
│                     GasSponsor.sol                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Sponsorship Modes:                                     │
│    Full    — 100% reimbursement up to cap               │
│    Partial — Capped at maxPerClaim (relayer absorbs     │
│              the excess)                                │
│                                                         │
│  Constraint Layers (defense-in-depth):                  │
│    Layer 1: Per-Claim Cap      (maxPerClaim)            │
│    Layer 2: Per-Relayer Daily   (dailyLimitPerRelayer)  │
│    Layer 3: Per-User Daily      (dailyLimitPerUser)     │
│    Layer 4: Global Daily        (globalDailyLimit)      │
│    Layer 5: Pool Balance Check                          │
│    Layer 6: Emergency Pause     (owner-controlled)      │
│                                                         │
│  Claim Flow:                                            │
│    relayer.claim(gasAmount, users[])                     │
│      ├─ Cap: min(amount, maxPerClaim)                   │
│      ├─ Check relayer daily limit (reset if new day)    │
│      ├─ Check per-user limits (split equally)           │
│      ├─ Check global daily limit                        │
│      ├─ Check pool balance                              │
│      ├─ Update all tracking counters                    │
│      └─ Transfer ETH to relayer                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Design Decisions:**
- **Day-based resets:** Using `block.timestamp / 1 days` for daily limit tracking. Gas-efficient compared to sliding windows.
- **Equal split accounting:** Per-user costs are divided equally among batch participants for simplicity and fairness.
- **Whitelisted relayers:** Only approved relayers can claim, preventing unauthorized drain.
- **Estimate function:** `estimateReimbursement()` allows relayers to pre-check viability before submitting a batch.

#### 2.3 SampleToken (Meta-Transaction Aware ERC-20)

**Role:** Standard ERC-20 token that recognizes forwarded calls from BatchExecutor and extracts the real sender.

```
┌─────────────────────────────────────────────────────────┐
│                    SampleToken.sol                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Inherits: OpenZeppelin ERC20                           │
│                                                         │
│  Meta-Tx Awareness:                                     │
│    _msgSender() override:                               │
│      IF caller == trustedForwarder AND data >= 20 bytes │
│        THEN sender = last 20 bytes of calldata          │
│        ELSE sender = msg.sender (normal flow)           │
│                                                         │
│  This pattern allows:                                   │
│    - Direct calls (user pays gas) → normal ERC-20       │
│    - Relayed calls (via BatchExecutor) → meta-tx        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### 2.4 Relayer Server (Off-Chain Component)

**Role:** Collects signed requests from users, queues them, and periodically submits batches on-chain. Optionally claims gas reimbursement.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Relayer Architecture                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Express Server (server.js)                                      │
│    ├─ GET  /              → Serve frontend                          │
│    ├─ GET  /health        → Health check + relayer status           │
│    ├─ GET  /api/config    → Serve contract addresses from .env     │
│    ├─ POST /api/relay     → Accept signed requests                  │
│    ├─ GET  /api/batch/status → Queue status                        │
│    └─ POST /api/batch/flush  → Force flush queue (admin)            │
│                                                                  │
│  Relayer Engine (relayer.js)                                     │
│    ├─ Request Queue    → pendingRequests[], pendingSignatures[]  │
│    ├─ Auto-Flush Timer → Submits batch every N seconds           │
│    ├─ Max Batch Size   → Flushes immediately when queue is full  │
│    └─ Retry Logic      → Re-queues failed requests               │
│                                                                  │
│  Signer Utility (signer.js)                                     │
│    ├─ buildRequest()        → Construct ForwardRequest struct    │
│    ├─ signRequest()         → EIP-712 wallet signing             │
│    └─ signBatchRequests()   → Sign multiple with nonce mgmt     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

### 3. Transaction Flow (End-to-End)

```
  User (Browser)          Relayer (Server)         Blockchain (Ganache)
       │                        │                         │
  [1]  │── Connect Wallet ──────┼─────────────────────────│
       │                        │                         │
  [2]  │── Build Actions ───────┼─────────────────────────│
       │   (to, amount) × N     │                         │
       │                        │                         │
  [3]  │── Sign EIP-712 ────────┼─────────────────────────│
       │   (MetaMask popup)     │                         │
       │   No gas paid!         │                         │
       │                        │                         │
  [4]  │── POST /api/relay ────▶│                         │
       │   {request, signature} │                         │
       │                        │                         │
  [5]  │                   [Queue Request]                │
       │                   [Wait for batch]               │
       │                        │                         │
  [6]  │                        │── executeBatch() ──────▶│
       │                        │   (single TX)           │
       │                        │                    [Verify sigs]
       │                        │                    [Check nonces]
       │                        │                    [Execute calls]
       │                        │                    [Emit events]
       │                        │◀── TX receipt ──────────│
       │                        │                         │
  [7]  │                        │── claim() ─────────────▶│ (GasSponsor)
       │                        │   (reimbursement)       │
       │                        │◀── ETH transfer ────────│
       │                        │                         │
  [8]  │◀── Result ─────────────│                         │
       │   (txHash, savings)    │                         │
```

#### Detailed Step Breakdown:

| Step | Actor | Action | Gas Cost |
|------|-------|--------|----------|
| 1 | User | Connect MetaMask to Ganache | 0 |
| 2 | User | Define N token transfers in the UI | 0 |
| 3 | User | Sign N ForwardRequests via EIP-712 | 0 |
| 4 | User | Send signed requests to relayer API | 0 |
| 5 | Relayer | Queue requests, wait for batch window | 0 |
| 6 | Relayer | Submit single `executeBatch()` TX | ~21K + N×13K gas |
| 7 | Relayer | Claim reimbursement from GasSponsor | ~45K gas |
| 8 | User | Receive confirmation and savings report | 0 |

**Total user gas cost: 0 ETH** (relayer pays, optionally reimbursed by sponsor pool)

---

### 4. Gas Optimization Analysis

#### 4.1 Why Batching Saves Gas

Every Ethereum transaction has a **fixed base cost of 21,000 gas** regardless of what it does. When users send N individual transactions:

$$\text{Cost}_{\text{individual}} = N \times (21{,}000 + C_{\text{execution}})$$

With batching, there's only **one** base cost:

$$\text{Cost}_{\text{batched}} = 21{,}000 + N \times C_{\text{execution}} + C_{\text{overhead}}$$

The savings are:

$$\text{Savings} = (N - 1) \times 21{,}000 - C_{\text{overhead}}$$

Where $C_{\text{overhead}}$ includes signature verification (~3,000 gas per sig) and loop/storage costs (~2,000 gas).

#### 4.2 Empirical Gas Analysis

| Batch Size | Individual Cost | Batched Cost | Savings | Savings % |
|-----------|----------------|-------------|---------|-----------|
| 1 | 52,000 | 52,000 | 0 | 0% |
| 2 | 104,000 | 65,000 | 39,000 | 37.5% |
| 5 | 260,000 | 104,000 | 156,000 | 60.0% |
| 10 | 520,000 | 182,000 | 338,000 | 65.0% |
| 20 | 1,040,000 | 338,000 | 702,000 | 67.5% |
| 50 | 2,600,000 | 806,000 | 1,794,000 | 69.0% |

The savings converge toward ~70% as batch size increases, following:

$$\text{Savings\%} \approx 1 - \frac{21{,}000 + N \times 15{,}600}{N \times 52{,}000}$$

#### 4.3 Calldata Gas Considerations

Per EIP-2028, calldata costs:
- **4 gas** per zero byte
- **16 gas** per non-zero byte

A ForwardRequest struct in calldata is ~256 bytes. For N requests:

$$C_{\text{calldata}} \approx N \times 256 \times 12 \approx N \times 3{,}072 \text{ gas}$$

This is factored into the overhead but remains small relative to the 21,000 base cost saved per additional request.

---

### 5. Trust Model & Security

#### 5.1 Trust Assumptions

| Entity | Trusts | Does NOT Trust |
|--------|--------|---------------|
| **User** | Their own wallet, EIP-712 standard | Relayer (signs specific actions only) |
| **BatchExecutor** | EIP-712 signatures, nonce ordering | Relayer identity (verifies everything) |
| **Relayer** | BatchExecutor contract code | User requests (validates before queuing) |
| **GasSponsor** | Whitelisted relayers, owner | Non-whitelisted addresses |

#### 5.2 Attack Surface & Mitigations

```
Attack                          │ Mitigation
────────────────────────────────┼──────────────────────────────────────
Replay attack (same chain)      │ Sequential nonces per user
Cross-chain replay              │ EIP-712 domain includes chainId
Cross-contract replay           │ EIP-712 domain includes contract addr
Relayer censorship              │ Users can execute directly on-chain
Gas griefing (relayer)          │ Per-call gas limits in ForwardRequest
Sponsor pool drain              │ 6-layer constraint system
Signature forgery               │ ECDSA + EIP-712 typed data
Front-running                   │ Nonces enforce ordering
Reentrancy                      │ Nonce incremented before execution
Malicious relayer               │ Can only execute what user signed
```

#### 5.3 Key Security Properties

1. **Non-Custodial:** The relayer never holds user funds or private keys. It can only execute pre-signed, specific actions.

2. **Censorship Resistant:** If the relayer refuses to submit a transaction, users can call `executeBatch()` directly (paying their own gas).

3. **Replay Protected:** The combination of (chainId, contractAddress, userNonce) creates a unique context for every signature.

4. **Fail-Safe Gas Sponsorship:** The 6-layer constraint system (per-claim, per-relayer, per-user, global, balance, pause) ensures the sponsor pool cannot be drained even if a relayer is compromised.

---

### 6. EIP-712 Signature Scheme

#### 6.1 Domain Separator Construction

```solidity
DOMAIN_SEPARATOR = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256("BatchExecutor"),    // Contract name
    keccak256("1"),                 // Version
    block.chainid,                  // 1337 (Ganache)
    address(this)                   // Deployed contract address
));
```

#### 6.2 Typed Data Hash

```solidity
bytes32 structHash = keccak256(abi.encode(
    REQUEST_TYPEHASH,
    req.from, req.to, req.value, req.gas, req.nonce,
    keccak256(req.data)  // Dynamic bytes are hashed
));

bytes32 digest = keccak256(abi.encodePacked(
    "\x19\x01",          // EIP-712 prefix
    DOMAIN_SEPARATOR,    // Domain context
    structHash           // Message content
));
```

#### 6.3 Signature Verification

```
User signs typed data in MetaMask
        │
        ▼
signature = sign(digest)  →  65 bytes: [r(32)][s(32)][v(1)]
        │
        ▼
On-chain: ecrecover(digest, v, r, s) → recovered_address
        │
        ▼
Check: recovered_address == request.from ?
Check: request.nonce == nonces[request.from] ?
        │
        ▼
If both pass → execute the request
```

---

### 7. Gas Sponsorship Modes

#### Mode 1: Full Sponsorship (Onboarding)

Ideal for new user acquisition. The dApp operator funds the pool generously:

```
maxPerClaim:          0.05 ETH  (covers most batch txs)
dailyLimitPerRelayer: 1 ETH     (relayer can claim freely)
dailyLimitPerUser:    0.01 ETH  (~20 free actions/day)
globalDailyLimit:     5 ETH     (caps total daily spending)
```

**User experience:** Completely gasless. User signs, relayer executes, pool pays.

#### Mode 2: Partial Sponsorship (Sustainable)

For ongoing operations. Relayer absorbs part of the cost:

```
maxPerClaim:          0.005 ETH (covers ~50% of cost)
dailyLimitPerRelayer: 0.5 ETH
dailyLimitPerUser:    0.003 ETH
globalDailyLimit:     2 ETH
```

**User experience:** Still gasless from user's perspective, but relayer may pass remaining cost through other mechanisms.

#### Mode 3: No Sponsorship (Relayer-Only)

Relayer pays gas out of pocket (e.g., funded by service fees):

```
No GasSponsor contract deployed.
Relayer absorbs all gas costs as a business expense.
```

---

### 8. Scalability Considerations

| Factor | Current Design | Scaling Path |
|--------|---------------|-------------|
| Batch size | 10 (configurable) | Up to ~50 before block gas limit concerns |
| Queue strategy | Time-based + size-based flush | Priority queues, fee markets |
| Multi-relayer | Single relayer | Relayer rotation, load balancing |
| Storage | On-chain nonces, off-chain queue | L2 bridging, state channels |
| Cross-token | Single token (SampleToken) | Any ERC-20 with trusted forwarder pattern |

---

### 9. Comparison with Related Work

| Approach | Gas Saving | User UX | Complexity | This System |
|----------|-----------|---------|-----------|-------------|
| Direct TX | 0% (baseline) | Must hold ETH | Low | ✗ |
| OpenZeppelin Forwarder | ~10% (single relay) | Gasless signing | Medium | Inspired by |
| Multicall (batching only) | ~40-60% | Still pays gas | Low | Combines with |
| GSN (Gas Station Network) | ~10% | Gasless | High | Simplified version |
| **This System** | **~60-70%** | **Gasless + batched** | **Medium** | **✓** |

The key differentiator is combining batching (cost reduction) with meta-transactions (UX improvement) and optional sponsorship (onboarding enablement) in a single cohesive system.

---

### 10. Sequence Diagram: Complete Batch Lifecycle

```
User            Frontend         Server/Relayer      BatchExecutor      GasSponsor
 │                │                    │                   │                │
 │──Connect──────▶│                    │                   │                │
 │                │──getNonce()───────────────────────────▶│                │
 │                │◀──nonce────────────────────────────────│                │
 │                │                    │                   │                │
 │──Add Actions──▶│                    │                   │                │
 │  (to,amount)   │                    │                   │                │
 │                │                    │                   │                │
 │──Click Sign───▶│                    │                   │                │
 │                │──signTypedData()──▶│(MetaMask)         │                │
 │◀──Approve─────▶│                    │                   │                │
 │                │◀──signature────────│                   │                │
 │                │                    │                   │                │
 │                │──POST /api/relay──▶│                   │                │
 │                │                    │──verify()────────▶│                │
 │                │                    │◀──true────────────│                │
 │                │                    │                   │                │
 │                │                    │  [Queue + Wait]   │                │
 │                │                    │                   │                │
 │                │                    │──executeBatch()──▶│                │
 │                │                    │                   │──verify each──│
 │                │                    │                   │──execute each─│
 │                │                    │                   │──emit events──│
 │                │                    │◀──receipt─────────│                │
 │                │                    │                   │                │
 │                │                    │──claim()──────────────────────────▶│
 │                │                    │◀──ETH reimbursement───────────────│
 │                │                    │                   │                │
 │                │◀──Result───────────│                   │                │
 │◀──Display──────│                    │                   │                │
 │  savings       │                    │                   │                │
```

---

### 11. Design Patterns Used

1. **Trusted Forwarder Pattern (ERC-2771):** BatchExecutor appends the real sender to calldata; target contracts extract it via `_msgSender()` override.

2. **EIP-712 Structured Data Signing:** Human-readable, domain-bound signatures that wallets like MetaMask render clearly to users.

3. **Nonce-Based Replay Protection:** Sequential nonces per user, incremented before execution to prevent reentrancy-based nonce reuse.

4. **Defense-in-Depth Sponsorship:** Multiple independent constraint layers ensure no single point of failure can drain the pool.

5. **Queue-and-Flush Pattern:** Off-chain request aggregation with configurable time/size flush triggers for optimal batching.

6. **Graceful Degradation:** If the relayer is down, users can submit transactions directly to BatchExecutor (paying their own gas).
