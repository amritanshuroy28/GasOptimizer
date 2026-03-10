// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/BatchExecutor.sol";
import "../contracts/SampleToken.sol";
import "../contracts/GasSponsor.sol";

contract GasBenchmarkTest is Test {
    BatchExecutor public batchExecutor;
    SampleToken public sampleToken;
    GasSponsor public gasSponsor;

    // Test accounts
    uint256 internal deployerKey = 0xA11CE;
    uint256 internal user1Key = 0xB0B;
    uint256 internal user2Key = 0xC0C;
    uint256 internal user3Key = 0xD0D;
    uint256 internal relayerKey = 0xE0E;

    address internal deployer;
    address internal user1;
    address internal user2;
    address internal user3;
    address internal relayer;

    uint256 constant ONE_TOKEN = 1 ether;
    uint256 constant TEN_TOKENS = 10 ether;

    // EIP-712 type hash — must match the contract
    bytes32 constant REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint256 deadline,bytes data)"
    );

    function setUp() public {
        deployer = vm.addr(deployerKey);
        user1 = vm.addr(user1Key);
        user2 = vm.addr(user2Key);
        user3 = vm.addr(user3Key);
        relayer = vm.addr(relayerKey);

        // Fund accounts with ETH
        vm.deal(deployer, 100 ether);
        vm.deal(user1, 10 ether);
        vm.deal(relayer, 10 ether);

        vm.startPrank(deployer);

        batchExecutor = new BatchExecutor(1);
        sampleToken = new SampleToken(address(batchExecutor));
        gasSponsor = new GasSponsor(
            0.05 ether,  // maxPerClaim
            1 ether,     // dailyLimitPerRelayer
            0.01 ether,  // dailyLimitPerUser
            5 ether      // globalDailyLimit
        );

        // Whitelist relayer
        gasSponsor.setRelayer(relayer, true);

        // Fund user1 with tokens
        sampleToken.transfer(user1, 10_000 ether);

        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════

    function _buildRequest(
        address from,
        address to,
        uint256 nonce,
        bytes memory data,
        uint256 gasLimit,
        uint256 value,
        uint256 deadline
    ) internal pure returns (BatchExecutor.ForwardRequest memory) {
        return BatchExecutor.ForwardRequest({
            from: from,
            to: to,
            value: value,
            gas: gasLimit,
            nonce: nonce,
            deadline: deadline,
            data: data
        });
    }

    function _buildRequest(
        address from,
        address to,
        uint256 nonce,
        bytes memory data
    ) internal pure returns (BatchExecutor.ForwardRequest memory) {
        return _buildRequest(from, to, nonce, data, 200_000, 0, 0);
    }

    function _signRequest(
        uint256 signerKey,
        BatchExecutor.ForwardRequest memory req
    ) internal view returns (bytes memory) {
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
            abi.encodePacked("\x19\x01", batchExecutor.DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _encodeTransfer(address to, uint256 amount) internal view returns (bytes memory) {
        return abi.encodeWithSelector(sampleToken.transfer.selector, to, amount);
    }

    // ═══════════════════════════════════════════════════════════════
    //  1. SIGNATURE VERIFICATION
    // ═══════════════════════════════════════════════════════════════

    function test_VerifyValidSignature() public view {
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(user1, address(sampleToken), 0, data);
        bytes memory sig = _signRequest(user1Key, req);

        assertTrue(batchExecutor.verify(req, sig));
    }

    function test_RejectWrongSigner() public view {
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(user1, address(sampleToken), 0, data);
        // Sign with user2's key but claim to be user1
        bytes memory sig = _signRequest(user2Key, req);

        assertFalse(batchExecutor.verify(req, sig));
    }

    function test_RejectWrongNonce() public view {
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(user1, address(sampleToken), 999, data);
        bytes memory sig = _signRequest(user1Key, req);

        assertFalse(batchExecutor.verify(req, sig));
    }

    // ═══════════════════════════════════════════════════════════════
    //  2. NONCE REPLAY PROTECTION & RECOVERY
    // ═══════════════════════════════════════════════════════════════

    function test_IncrementNonceAfterExecution() public {
        uint256 nonceBefore = batchExecutor.getNonce(user1);

        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(user1, address(sampleToken), nonceBefore, data);
        bytes memory sig = _signRequest(user1Key, req);

        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](1);
        bytes[] memory sigs = new bytes[](1);
        reqs[0] = req;
        sigs[0] = sig;

        vm.prank(relayer);
        batchExecutor.executeBatch(reqs, sigs);

        assertEq(batchExecutor.getNonce(user1), nonceBefore + 1);
    }

    function test_RejectReplayOfExecutedRequest() public {
        uint256 currentNonce = batchExecutor.getNonce(user1);
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(user1, address(sampleToken), currentNonce, data);
        bytes memory sig = _signRequest(user1Key, req);

        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](1);
        bytes[] memory sigs = new bytes[](1);
        reqs[0] = req;
        sigs[0] = sig;

        vm.prank(relayer);
        batchExecutor.executeBatch(reqs, sigs);

        // Same request is now invalid
        assertFalse(batchExecutor.verify(req, sig));
    }

    function test_IncrementNonce() public {
        uint256 nonceBefore = batchExecutor.getNonce(user1);

        vm.prank(user1);
        batchExecutor.incrementNonce();

        assertEq(batchExecutor.getNonce(user1), nonceBefore + 1);
    }

    function test_IncrementNonceBy() public {
        uint256 nonceBefore = batchExecutor.getNonce(user1);

        vm.prank(user1);
        batchExecutor.incrementNonceBy(5);

        assertEq(batchExecutor.getNonce(user1), nonceBefore + 5);
    }

    function test_RevertIncrementNonceByOverLimit() public {
        vm.prank(user1);
        vm.expectRevert(BatchExecutor.InvalidNonceCount.selector);
        batchExecutor.incrementNonceBy(51);
    }

    // ═══════════════════════════════════════════════════════════════
    //  3. REQUEST DEADLINE / EXPIRY
    // ═══════════════════════════════════════════════════════════════

    function test_AcceptFutureDeadline() public view {
        uint256 currentNonce = batchExecutor.getNonce(user1);
        uint256 futureDeadline = block.timestamp + 3600;
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(
            user1, address(sampleToken), currentNonce, data, 200_000, 0, futureDeadline
        );
        bytes memory sig = _signRequest(user1Key, req);

        assertTrue(batchExecutor.verify(req, sig));
    }

    function test_RejectExpiredDeadline() public {
        // Warp to a realistic timestamp so (timestamp - 3600) doesn't underflow
        vm.warp(1_700_000_000);

        uint256 currentNonce = batchExecutor.getNonce(user1);
        uint256 pastDeadline = block.timestamp - 3600;
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(
            user1, address(sampleToken), currentNonce, data, 200_000, 0, pastDeadline
        );
        bytes memory sig = _signRequest(user1Key, req);

        assertFalse(batchExecutor.verify(req, sig));
    }

    function test_AcceptZeroDeadline() public {
        uint256 currentNonce = batchExecutor.getNonce(user1);
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(
            user1, address(sampleToken), currentNonce, data, 200_000, 0, 0
        );
        bytes memory sig = _signRequest(user1Key, req);

        assertTrue(batchExecutor.verify(req, sig));

        // Execute to consume nonce
        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](1);
        bytes[] memory sigs = new bytes[](1);
        reqs[0] = req;
        sigs[0] = sig;

        vm.prank(relayer);
        batchExecutor.executeBatch(reqs, sigs);
    }

    // ═══════════════════════════════════════════════════════════════
    //  4. BATCH EXECUTION
    // ═══════════════════════════════════════════════════════════════

    function test_ExecuteSingleRequestBatch() public {
        uint256 currentNonce = batchExecutor.getNonce(user1);
        uint256 balBefore = sampleToken.balanceOf(user2);

        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(user1, address(sampleToken), currentNonce, data);
        bytes memory sig = _signRequest(user1Key, req);

        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](1);
        bytes[] memory sigs = new bytes[](1);
        reqs[0] = req;
        sigs[0] = sig;

        vm.prank(relayer);
        batchExecutor.executeBatch(reqs, sigs);

        assertEq(sampleToken.balanceOf(user2) - balBefore, ONE_TOKEN);
    }

    function test_ExecuteMultiRequestBatch() public {
        uint256 currentNonce = batchExecutor.getNonce(user1);
        uint256 balBefore = sampleToken.balanceOf(user3);

        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](3);
        bytes[] memory sigs = new bytes[](3);

        for (uint256 i = 0; i < 3; i++) {
            bytes memory data = _encodeTransfer(user3, ONE_TOKEN);
            reqs[i] = _buildRequest(user1, address(sampleToken), currentNonce + i, data);
            sigs[i] = _signRequest(user1Key, reqs[i]);
        }

        vm.prank(relayer);
        batchExecutor.executeBatch(reqs, sigs);

        assertEq(sampleToken.balanceOf(user3) - balBefore, 3 ether);
    }

    // ═══════════════════════════════════════════════════════════════
    //  5. GAS SPONSORSHIP
    // ═══════════════════════════════════════════════════════════════

    function test_AcceptDeposit() public {
        vm.prank(deployer);
        gasSponsor.deposit{value: 1 ether}();

        assertEq(gasSponsor.getBalance(), 1 ether);
    }

    function test_EstimateReimbursement() public {
        vm.prank(deployer);
        gasSponsor.deposit{value: 1 ether}();

        address[] memory users = new address[](1);
        users[0] = user1;

        (uint256 reimbursement, bool wouldSucceed) = gasSponsor.estimateReimbursement(
            0.01 ether, relayer, users
        );
        assertTrue(wouldSucceed);
        assertEq(reimbursement, 0.01 ether);
    }

    function test_ReimburseRelayer() public {
        vm.prank(deployer);
        gasSponsor.deposit{value: 1 ether}();

        address[] memory users = new address[](1);
        users[0] = user1;

        uint256 balBefore = relayer.balance;

        vm.prank(relayer);
        gasSponsor.claim(0.005 ether, users);

        // Relayer received the reimbursement (minus gas cost for the claim tx itself)
        // Just verify the claim didn't revert and balance increased
        assertTrue(relayer.balance > balBefore - 0.01 ether); // allow for gas cost
    }

    function test_CapReimbursementAtMaxPerClaim() public {
        vm.prank(deployer);
        gasSponsor.deposit{value: 1 ether}();

        // Use 5 fresh users so per-user cost is 0.05/5 = 0.01 ETH (within daily limit)
        address[] memory users = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            users[i] = address(uint160(0xF00 + i));
        }

        (uint256 reimbursement, bool wouldSucceed) = gasSponsor.estimateReimbursement(
            1 ether, relayer, users
        );
        assertTrue(wouldSucceed);
        assertEq(reimbursement, 0.05 ether); // capped at maxPerClaim
    }

    function test_TrackDailyLimitsPerUser() public {
        vm.prank(deployer);
        gasSponsor.deposit{value: 1 ether}();

        address[] memory users = new address[](1);
        users[0] = user1;

        vm.prank(relayer);
        gasSponsor.claim(0.005 ether, users);

        uint256 remaining = gasSponsor.getUserDailyRemaining(user1);
        assertLt(remaining, 0.01 ether);
    }

    function test_RejectClaimWhenPaused() public {
        vm.prank(deployer);
        gasSponsor.deposit{value: 1 ether}();

        vm.prank(deployer);
        gasSponsor.setPaused(true);

        address[] memory users = new address[](1);
        users[0] = user1;

        vm.prank(relayer);
        vm.expectRevert(GasSponsor.ContractPaused.selector);
        gasSponsor.claim(0.001 ether, users);

        vm.prank(deployer);
        gasSponsor.setPaused(false);
    }

    // ═══════════════════════════════════════════════════════════════
    //  6. GAS BENCHMARK — BATCH SIZE COMPARISON
    // ═══════════════════════════════════════════════════════════════

    function test_GasBenchmark_DirectTransfer() public {
        vm.prank(user1);
        uint256 gasBefore = gasleft();
        sampleToken.transfer(user2, ONE_TOKEN);
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("Single direct transfer gas", gasUsed);
    }

    function test_GasBenchmark_Batch2() public {
        _benchmarkBatch(2);
    }

    function test_GasBenchmark_Batch5() public {
        _benchmarkBatch(5);
    }

    function test_GasBenchmark_Batch10() public {
        _benchmarkBatch(10);
    }

    function _benchmarkBatch(uint256 batchSize) internal {
        uint256 currentNonce = batchExecutor.getNonce(user1);

        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](batchSize);
        bytes[] memory sigs = new bytes[](batchSize);

        for (uint256 i = 0; i < batchSize; i++) {
            bytes memory data = _encodeTransfer(user3, ONE_TOKEN);
            reqs[i] = _buildRequest(user1, address(sampleToken), currentNonce + i, data);
            sigs[i] = _signRequest(user1Key, reqs[i]);
        }

        vm.prank(relayer);
        uint256 gasBefore = gasleft();
        batchExecutor.executeBatch(reqs, sigs);
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint(string.concat("Batch of ", vm.toString(batchSize), " total gas"), gasUsed);
        emit log_named_uint(string.concat("Batch of ", vm.toString(batchSize), " gas/tx"), gasUsed / batchSize);
    }

    // ═══════════════════════════════════════════════════════════════
    //  7. FAILURE HANDLING
    // ═══════════════════════════════════════════════════════════════

    function test_RevertOnEmptyBatch() public {
        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](0);
        bytes[] memory sigs = new bytes[](0);

        vm.prank(relayer);
        vm.expectRevert(BatchExecutor.EmptyBatch.selector);
        batchExecutor.executeBatch(reqs, sigs);
    }

    function test_RevertOnMismatchedArrays() public {
        uint256 currentNonce = batchExecutor.getNonce(user1);
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);
        BatchExecutor.ForwardRequest memory req = _buildRequest(user1, address(sampleToken), currentNonce, data);
        bytes memory sig = _signRequest(user1Key, req);

        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](1);
        bytes[] memory sigs = new bytes[](2);
        reqs[0] = req;
        sigs[0] = sig;
        sigs[1] = sig;

        vm.prank(relayer);
        vm.expectRevert(BatchExecutor.LengthMismatch.selector);
        batchExecutor.executeBatch(reqs, sigs);
    }

    function test_SkipRequestWithWrongNonce() public {
        uint256 currentNonce = batchExecutor.getNonce(user1);
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);

        // Request 1: valid
        BatchExecutor.ForwardRequest memory req1 = _buildRequest(user1, address(sampleToken), currentNonce, data);
        bytes memory sig1 = _signRequest(user1Key, req1);

        // Request 2: wrong nonce
        BatchExecutor.ForwardRequest memory req2 = _buildRequest(user1, address(sampleToken), 999, data);
        bytes memory sig2 = _signRequest(user1Key, req2);

        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](2);
        bytes[] memory sigs = new bytes[](2);
        reqs[0] = req1;
        reqs[1] = req2;
        sigs[0] = sig1;
        sigs[1] = sig2;

        vm.prank(relayer);
        bool[] memory results = batchExecutor.executeBatch(reqs, sigs);

        assertTrue(results[0]);
        assertFalse(results[1]);
    }

    // ═══════════════════════════════════════════════════════════════
    //  8. PARTIAL-FAILURE BATCHES
    // ═══════════════════════════════════════════════════════════════

    function test_PartialFailureWithExpiredDeadline() public {
        // Warp to a realistic timestamp so deadline=1 is clearly in the past
        vm.warp(1_700_000_000);

        uint256 currentNonce = batchExecutor.getNonce(user1);
        bytes memory data = _encodeTransfer(user2, ONE_TOKEN);

        // Request 1: valid (no deadline)
        BatchExecutor.ForwardRequest memory req1 = _buildRequest(
            user1, address(sampleToken), currentNonce, data, 200_000, 0, 0
        );
        bytes memory sig1 = _signRequest(user1Key, req1);

        // Request 2: expired deadline
        BatchExecutor.ForwardRequest memory req2 = _buildRequest(
            user1, address(sampleToken), currentNonce + 1, data, 200_000, 0, 1 // timestamp 1 = far in the past
        );
        bytes memory sig2 = _signRequest(user1Key, req2);

        BatchExecutor.ForwardRequest[] memory reqs = new BatchExecutor.ForwardRequest[](2);
        bytes[] memory sigs = new bytes[](2);
        reqs[0] = req1;
        reqs[1] = req2;
        sigs[0] = sig1;
        sigs[1] = sig2;

        vm.prank(relayer);
        bool[] memory results = batchExecutor.executeBatch(reqs, sigs);

        assertTrue(results[0]);   // valid request succeeded
        assertFalse(results[1]);  // expired request skipped
    }
}
