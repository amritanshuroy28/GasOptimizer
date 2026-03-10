// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/BatchExecutor.sol";
import "../contracts/SampleToken.sol";
import "../contracts/GasSponsor.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        // Detect network — use lower limits on Sepolia to conserve testnet ETH
        bool isSepolia = block.chainid == 11155111;

        console.log(unicode"╔══════════════════════════════════════════════╗");
        console.log(unicode"║     Batch Executor — Contract Deployment     ║");
        console.log(unicode"╠══════════════════════════════════════════════╣");
        console.log("  Chain ID:", block.chainid);
        console.log("  Deployer:", deployer);
        console.log(unicode"╚══════════════════════════════════════════════╝");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy BatchExecutor
        BatchExecutor batchExecutor = new BatchExecutor(1);
        console.log("  BatchExecutor:", address(batchExecutor));

        // 2. Deploy SampleToken
        SampleToken sampleToken = new SampleToken(address(batchExecutor));
        console.log("  SampleToken:", address(sampleToken));

        // 3. Deploy GasSponsor
        uint256 maxPerClaim = isSepolia ? 0.005 ether : 0.05 ether;
        uint256 dailyLimitPerRelayer = isSepolia ? 0.1 ether : 1.0 ether;
        uint256 dailyLimitPerUser = isSepolia ? 0.002 ether : 0.01 ether;
        uint256 globalDailyLimit = isSepolia ? 0.5 ether : 5.0 ether;

        GasSponsor gasSponsor = new GasSponsor(
            maxPerClaim,
            dailyLimitPerRelayer,
            dailyLimitPerUser,
            globalDailyLimit
        );
        console.log("  GasSponsor:", address(gasSponsor));

        // 4. Whitelist deployer as relayer
        gasSponsor.setRelayer(deployer, true);
        console.log("  Relayer whitelisted:", deployer);

        vm.stopBroadcast();

        // 5. Write deployment addresses to a JSON file for the post-deploy script
        string memory json = "deployment";
        vm.serializeAddress(json, "BatchExecutor", address(batchExecutor));
        vm.serializeAddress(json, "SampleToken", address(sampleToken));
        vm.serializeAddress(json, "GasSponsor", address(gasSponsor));
        vm.serializeAddress(json, "Deployer", deployer);
        vm.serializeUint(json, "ChainId", block.chainid);
        string memory output = vm.serializeString(json, "Timestamp", vm.toString(block.timestamp));

        vm.writeJson(output, "./deployment.json");
        console.log(unicode"\n✓ deployment.json written");
    }
}
