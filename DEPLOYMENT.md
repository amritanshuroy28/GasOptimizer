# Batch Executor - Gas Optimized Batch Relay dApp

## Setup & Deployment Guide

### Prerequisites

1. **Node.js** (v18+) - Already installed ✓
2. **Ganache** - Local Ethereum blockchain (download from [trufflesuite.com/ganache](https://trufflesuite.com/ganache/))
3. **Private Key** - Use a Ganache account private key

### Installation

All dependencies are already installed:
```bash
npm install
```

### Environment Setup

Create a `.env` file in the root directory with:

```env
# Ganache RPC URL (default local)
GANACHE_RPC_URL=http://127.0.0.1:7545

# Deployer Private Key (use a Ganache account key)
DEPLOYER_PRIVATE_KEY=0xYOUR_GANACHE_PRIVATE_KEY

# Server Configuration
RELAYER_PRIVATE_KEY=0xYOUR_GANACHE_PRIVATE_KEY

# Auto-populated after deployment
BATCH_EXECUTOR_ADDRESS=
SAMPLE_TOKEN_ADDRESS=
GAS_SPONSOR_ADDRESS=
RELAYER_ADDRESS=
```

### Step 1: Start Ganache

1. Launch Ganache on your machine
2. It provides 10 pre-funded accounts with 100 ETH each
3. Copy a private key from one of the accounts for your `.env`

### Step 2: Compile Contracts

```bash
npm run compile
```

This will:
- Download the Solidity 0.8.20 compiler
- Compile all contracts in `./contracts/`
- Generate artifacts in `./build/contracts/`

### Step 3: Deploy Contracts

```bash
npm run deploy
```

The deployment script will:
1. Deploy BatchExecutor contract
2. Deploy SampleToken with BatchExecutor as the trusted forwarder
3. Deploy GasSponsor with predefined limits
4. Whitelist the relayer address in GasSponsor
5. Update `.env` with deployed contract addresses
6. Save deployment info to `deployment.json`

### Step 4: Fund GasSponsor Pool

Send ETH to the GasSponsor contract address (shown after deployment):

```bash
# Using cast (Foundry)
cast send <GAS_SPONSOR_ADDRESS> --value 0.1ether

# Or send ETH through Ganache's built-in tools or MetaMask
```

### Step 5: Start the Server

```bash
npm start
```

The server will run on http://localhost:3000

## File Structure

```
.
├── contracts/                 # Solidity contracts
│   ├── BatchExecutor.sol      # Main batch execution contract
│   ├── GasSponsor.sol         # Gas sponsorship pool
│   └── SampleToken.sol        # ERC-20 token for testing
├── migrations/                # Truffle migration scripts
│   ├── 1_initial_migration.js # Required initial migration
│   └── 2_deploy_contracts.js  # Deploys all contracts, updates .env
├── build/contracts/           # Compiled artifacts (generated)
├── index.html                 # Frontend dApp interface
├── server.js                  # Express server
├── relayer.js                 # Relayer logic
├── signer.js                  # Offline signer utility
├── truffle-config.js          # Truffle configuration
├── package.json               # Dependencies
└── .env                       # Environment variables (create this)
```

## Contract Addresses

After deployment, check `deployment.json` for:
- `BatchExecutor.address` - Main contract for batching
- `SampleToken.address` - Test token
- `GasSponsor.address` - Gas sponsorship pool

The frontend automatically fetches these addresses from the server via `GET /api/config`, so no manual editing of `index.html` is needed.

To verify the config endpoint:
```bash
curl http://localhost:3000/api/config
```

## Gas Sponsor Configuration

Default limits (adjust in `migrations/2_deploy_contracts.js` before deploying):

- **Max per claim**: 0.05 ETH
- **Daily relayer limit**: 1 ETH
- **Daily user limit**: 0.01 ETH per address
- **Global daily limit**: 5 ETH total

## Features

### 1. Batch Execution
- Users sign transactions off-chain
- Relayer collects and batches them
- Execute multiple transactions in one call
- **Gas savings**: ~70% reduction vs individual txs

### 2. Meta-Transactions
- Users don't pay gas directly
- Relayer submits batched transactions
- Optional gas sponsorship pool for subsidy

### 3. EIP-712 Signatures
- Standard signature format (Web3.js compatible)
- Replay protection via nonce + chain ID
- Signature verification on-chain

### 4. Gas Sponsorship
- Configurable sponsorship tiers
- Daily limits per relayer/user/global
- Emergency pause functionality
- Owner can adjust limits or withdraw funds

## API Endpoints

### GET /
HTML frontend interface

### GET /health
Check server and relayer status
```json
{
  "status": "ok",
  "relayer": "initialized|not configured",
  "timestamp": "2026-02-22T..."
}
```

### GET /api/config
Get deployed contract addresses (auto-served from .env)
```json
{
  "batchExecutorAddress": "0x...",
  "sampleTokenAddress": "0x...",
  "gasSponsorAddress": "0x...",
  "rpcUrl": "http://127.0.0.1:7545"
}
```

### GET /api/batch/status
Get current batch queue status
```json
{
  "queueLength": 3,
  "maxBatchSize": 10,
  "flushIntervalMs": 15000
}
```

### POST /api/batch/flush
Force flush the current queue (admin endpoint)

### GET /api/gas-stats
Get gas usage analytics and batch history
```json
{
  "totalBatches": 5,
  "totalTransactions": 23,
  "totalGasUsed": "523000",
  "totalGasSaved": "677000",
  "averageSavingsPercent": 34,
  "history": [...]
}
```

### GET /api/nonce/:address
Get on-chain nonce for a user address (for frontend sync)
```json
{
  "address": "0x...",
  "nonce": 7
}
```

### POST /api/relay
Submit a signed request
```json
{
  "request": {
    "from": "0x...",
    "to": "0x...",
    "value": "0",
    "gas": "100000",
    "nonce": "0",
    "data": "0x..."
  },
  "signature": "0x..."
}
```

## Testing

### 1. Connect Wallet in Frontend
- Open http://localhost:3000
- Connect MetaMask to Ganache (chainId 1337, RPC http://127.0.0.1:7545)

### 2. Send Test Transactions
- Select recipients
- Set amount
- Sign and submit

### 3. Monitor Relayer
- Check server logs for batch submissions
- Track gas savings

## Troubleshooting

### Compilation fails
```bash
# Clear build cache and recompile
rm -rf build
npm run compile
```

### Deployment fails
- Check RPC URL is correct
- Verify private key has funds
- Ensure correct network selected
- Check gas price/limit settings

### Server won't start
```bash
# Check if port 3000 is in use
lsof -i :3000  # macOS/Linux
netstat -ano | findstr :3000  # Windows
```

### Relayer not initialized
- Verify all environment variables in `.env`
- Check contract addresses are correct
- Ensure RPC URL is working

## Security Notes

🚨 **IMPORTANT**: Never use mainnet private keys!

1. Always use testnet accounts
2. Never commit `.env` to git
3. Use environment variables in production
4. The GasSponsor contract owns the sponsorship pool
5. Owner can pause claims and withdraw funds

## Next Steps

1. Deploy to Ganache (local network)
2. Test batch transactions
3. Monitor gas savings
4. Adjust sponsorship limits as needed
5. Deploy to a testnet or mainnet (when ready)

## Support

For issues or questions:
- Check Solidity contracts for inline documentation
- Review Truffle docs: https://trufflesuite.com/docs/truffle/
- Ethers.js docs: https://docs.ethers.org/v6/

Good luck! 🚀
