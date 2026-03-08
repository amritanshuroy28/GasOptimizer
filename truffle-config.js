/**
 * Truffle configuration for Gas Optimizer project.
 * Uses Ganache as the development blockchain.
 *
 * @see https://trufflesuite.com/docs/truffle/reference/configuration/
 */

require("dotenv").config();

const GANACHE_RPC_URL = process.env.GANACHE_RPC_URL || "http://127.0.0.1:7545";

// Parse host and port from the RPC URL
const url = new URL(GANACHE_RPC_URL);

module.exports = {
  contracts_directory: "./contracts",
  contracts_build_directory: "./build/contracts",

  networks: {
    // Ganache GUI (default port 7545)
    ganache: {
      host: url.hostname,
      port: parseInt(url.port) || 7545,
      network_id: "*",
      gas: 6721975,
      gasPrice: 20000000000, // 20 gwei
    },

    // Ganache CLI / local node (port 8545)
    development: {
      host: "127.0.0.1",
      port: 8545,
      network_id: "*",
    },
  },

  // Solidity compiler settings
  compilers: {
    solc: {
      version: "0.8.24",
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
        evmVersion: "london",
      },
    },
  },
};
