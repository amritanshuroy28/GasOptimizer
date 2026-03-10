# Setup Checklist

## What's Been Done

### Project Structure
- Organized contracts into `contracts/` directory
- Foundry configuration (`foundry.toml`, `remappings.txt`)
- Foundry deploy script (`script/Deploy.s.sol`)
- Foundry test suite (`test/GasBenchmark.t.sol`)
- Render.com deployment config (`render.yaml`)

### Smart Contracts (Ready to Deploy)
- **BatchExecutor.sol** - EIP-712 signature verification & batch execution
- **GasSponsor.sol** - Configurable gas sponsorship pool
- **SampleToken.sol** - ERC-20 test token with meta-tx support

### Deployment Setup
- Foundry configuration (`foundry.toml`) with optimizer 1000 runs + viaIR
- Deploy script (`script/Deploy.s.sol`) with Sepolia-aware limits
- Post-deploy script (`script/post-deploy.js`) auto-updates `.env` and `deployment.json`
- Environment variable template (`.env.example`)

### Backend Server
- Express.js server (`server.js`) serves frontend + API
- Relayer logic batches transactions (`relayer.js`)
- Transaction signing utility (`signer.js`)
- Dynamic network config via `GET /api/config` (returns chainId, blockExplorer, etc.)

### Testing
- 27 Foundry Solidity tests covering signatures, nonces, deadlines, batching, sponsorship, gas benchmarks, and failure handling
- `forge test --gas-report` for per-function gas measurements

### Documentation
- Comprehensive README.md
- Detailed DEPLOYMENT.md guide
- System architecture in ARCHITECTURE.md
- This setup checklist

## What You Need to Do

### Step 1: Install Foundry
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### Step 2: Get Sepolia ETH
Visit a Sepolia faucet (e.g., sepoliafaucet.com) and request testnet ETH for your deployer wallet.

### Step 3: Create `.env` File
```bash
cp .env.example .env
```

Fill in your values:
```env
SEPOLIA_RPC_URL=https://rpc.sepolia.org
DEPLOYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
RELAYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
```

### Step 4: Compile & Deploy
```bash
forge build
npm run deploy:sepolia
```

### Step 5: Start Server
```bash
npm start
```
Opens: http://localhost:3000

### Step 6: Deploy to Render.com (Optional)
Push to GitHub, connect on Render.com, set env vars in the dashboard.

> **Note:** The frontend fetches contract addresses automatically from `GET /api/config`. No manual editing of `index.html` is needed after deployment.

## Command Reference

```bash
# Compilation
forge build                    # Compile Solidity contracts

# Testing
forge test -vv                 # Run all 27 tests
forge test --gas-report        # Run tests with gas breakdown
forge test --match-test test_GasBenchmark  # Run only gas benchmarks

# Deployment
npm run deploy:sepolia         # Deploy to Sepolia + update .env
npm run deploy:local           # Deploy to local Anvil node
npm run post-deploy            # Re-run .env update from deployment.json

# Server
npm start                      # Start Express server
npm run dev                    # Same as start

# Foundry utilities
forge clean                    # Clear compilation cache
cast call <addr> "getBalance()" --rpc-url $SEPOLIA_RPC_URL   # Read contract
cast send <addr> "deposit()" --value 0.05ether --rpc-url $SEPOLIA_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY  # Write contract

# Health checks
curl http://localhost:3000/health
curl http://localhost:3000/api/config
```

## Project Files

### Configuration
- `foundry.toml` - Foundry compiler/network settings
- `remappings.txt` - Solidity import remappings
- `render.yaml` - Render.com deployment blueprint
- `package.json` - Node.js dependencies and scripts
- `.env.example` - Environment variable template
- `.env` - Environment variables (create this)
- `deployment.json` - Generated after deployment

### Smart Contracts
- `contracts/BatchExecutor.sol` - Main batching contract
- `contracts/GasSponsor.sol` - Gas sponsorship pool
- `contracts/SampleToken.sol` - ERC-20 token for testing

### Scripts & Tests
- `script/Deploy.s.sol` - Foundry Solidity deploy script
- `script/post-deploy.js` - Post-deploy .env updater
- `test/GasBenchmark.t.sol` - 27 Foundry tests

### Backend
- `server.js` - Express server with API endpoints
- `relayer.js` - Batch collection and execution logic
- `signer.js` - Off-chain transaction signing

### Frontend
- `index.html` - Web interface for users

### Dependencies (lib/)
- `lib/forge-std/` - Foundry standard library
- `lib/openzeppelin-contracts/` - OpenZeppelin ERC-20 and utilities

### Documentation
- `README.md` - Complete guide
- `DEPLOYMENT.md` - Detailed deployment steps
- `ARCHITECTURE.md` - System architecture design
- `SETUP.md` - This file

## Architecture Overview

```
+---------------------------------------------------+
|         User's Browser (index.html)               |
|  - Connect wallet (MetaMask on Sepolia)           |
|  - Sign transactions (EIP-712, no gas)            |
|  - Submit to relayer                              |
+---------------------------+-----------------------+
                            |
                            | POST /api/relay
                            v
+---------------------------------------------------+
|         Express Server (server.js)                |
|  - Receives signed requests                       |
|  - Queues them in relayer                         |
|  - Serves /api/config with network info           |
+---------------------------+-----------------------+
                            |
                            v
+---------------------------------------------------+
|         Relayer (relayer.js)                      |
|  - Collects requests (up to 15 seconds)           |
|  - Verifies signatures                            |
|  - Batches them together                          |
|  - Submits to blockchain                          |
+---------------------------+-----------------------+
                            |
                            v executeBatch()
+---------------------------------------------------+
|   Smart Contracts on Sepolia                      |
|  - BatchExecutor: Verifies & executes batch       |
|  - GasSponsor: Reimburses relayer's gas           |
|  - SampleToken: Test ERC-20 token                 |
+---------------------------------------------------+
```

## Gas Sponsor Configuration

Default Sepolia settings (set in `script/Deploy.s.sol`):

```
maxPerClaim:          0.005 ETH    # Max reimbursement per batch
dailyLimitPerRelayer: 0.1 ETH     # Relayer can claim per day
dailyLimitPerUser:    0.002 ETH   # Each user benefits max per day
globalDailyLimit:     0.5 ETH     # Total pool limit per day
```

Local development settings (Anvil) use 10x higher limits.

## Expected Results

After deployment, you'll have:

1. **Three deployed contracts** on Sepolia
   - Addresses saved in `.env` and `deployment.json`
   - Verifiable on [sepolia.etherscan.io](https://sepolia.etherscan.io)

2. **Running server** on localhost:3000 or Render.com
   - Web interface for batching transactions
   - API endpoints for relayer integration

3. **Gas savings** (measured by `forge test --gas-report`, including 21K base cost)
   - Single direct transfer: ~57,964 gas (36,964 execution + 21,000 base)
   - Batch of 2: ~49,703 gas/tx (14% savings)
   - Batch of 5: ~26,804 gas/tx (54% savings)
   - Batch of 10: ~19,180 gas/tx (67% savings)

## Network Info

**Sepolia Testnet:**
- Chain ID: 11155111
- RPC URL: https://rpc.sepolia.org
- Block Explorer: https://sepolia.etherscan.io
- Get testnet ETH from faucets
- Add to MetaMask as Sepolia network (usually pre-configured)

## Support & Resources

- **Foundry Book**: https://book.getfoundry.sh/
- **Ethers.js Docs**: https://docs.ethers.org/v6
- **EIP-712 Spec**: https://eips.ethereum.org/EIPS/eip-712
- **Render.com Docs**: https://docs.render.com/
