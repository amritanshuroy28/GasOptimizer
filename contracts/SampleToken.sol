// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title SampleToken
 * @author Gas Fee Optimizer — Batch Transaction System
 * @notice A meta-transaction-aware ERC-20 token for demonstrating gas-optimized
 *         batch transfers via the BatchExecutor trusted forwarder.
 *
 * @dev Implements the Trusted Forwarder pattern (ERC-2771):
 *   - When called directly by a user → standard ERC-20 behavior
 *   - When called via BatchExecutor → extracts real sender from calldata
 *
 * KEY FIXES (v2):
 *   - Added _msgData() override (ERC-2771 requires BOTH _msgSender and _msgData)
 *   - Improved calldata length check: must be at least 4 (selector) + 20 (sender)
 *   - Made trustedForwarder immutable for gas savings
 *   - Added isTrustedForwarder() view function per ERC-2771 spec
 *
 * SENDER PROPAGATION:
 *   BatchExecutor appends the original sender address (20 bytes) to the end
 *   of the calldata when forwarding calls.
 *
 *   calldata layout for forwarded calls:
 *   [4-byte selector][original function params][sender address (20 bytes)]
 */
contract SampleToken is ERC20 {

    /// @notice The BatchExecutor address (immutable for gas savings)
    address public immutable trustedForwarder;

    constructor(
        address _trustedForwarder
    ) ERC20("SampleToken", "SMPL") {
        require(_trustedForwarder != address(0), "SampleToken: zero forwarder");
        trustedForwarder = _trustedForwarder;
        // Mint 1 million tokens to the deployer for testing
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    /// @notice Check if an address is the trusted forwarder (per ERC-2771 spec)
    function isTrustedForwarder(address forwarder) public view returns (bool) {
        return forwarder == trustedForwarder;
    }

    /**
     * @notice Override _msgSender to support meta-transactions.
     * If the call comes from the trusted forwarder (BatchExecutor),
     * the real sender is appended to the calldata (last 20 bytes).
     *
     * Calldata must be at least 24 bytes (4-byte selector + 20-byte sender)
     * for the forwarded path to be valid.
     */
    function _msgSender() internal view override returns (address sender) {
        if (msg.sender == trustedForwarder && msg.data.length >= 24) {
            // Extract the original sender from the last 20 bytes
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    /**
     * @notice Override _msgData to strip the appended sender for forwarded calls.
     * Without this override, the appended 20 bytes would be misinterpreted
     * as part of the function arguments, causing decoding errors for functions
     * with dynamic-length parameters.
     */
    function _msgData() internal view override returns (bytes calldata) {
        if (msg.sender == trustedForwarder && msg.data.length >= 24) {
            return msg.data[:msg.data.length - 20];
        } else {
            return msg.data;
        }
    }
}
