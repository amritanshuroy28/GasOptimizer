import { defineConfig } from "hardhat/config";
import HardhatEthersPlugin from "@nomicfoundation/hardhat-ethers";
import "dotenv/config.js";

const GANACHE_RPC_URL = process.env.GANACHE_RPC_URL || "http://127.0.0.1:7545";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";

export default defineConfig({
    plugins: [
        HardhatEthersPlugin,
    ],
    solidity: {
        version: "0.8.20",
        settings: {
            evmVersion: "paris",
            optimizer: {
                enabled: true,
                runs: 200
            }
        }
    },
    networks: {
        ganache: {
            url: GANACHE_RPC_URL,
            accounts: [DEPLOYER_PRIVATE_KEY],
            chainId: 1337,
            type: "http"
        },
        localhost: {
            url: "http://127.0.0.1:8545",
            chainId: 31337,
            type: "http"
        }
    },
    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./hardhat_cache",
        artifacts: "./artifacts"
    }
});
