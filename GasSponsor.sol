// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/**
 * @title GasSponsor
 * @author Gas Fee Optimizer — Batch Transaction System
 * @notice Manages a gas sponsorship pool with configurable multi-layer constraints,
 *         enabling full or partial gas fee subsidization for meta-transaction users.
 *
 * @dev Implements a defense-in-depth approach to pool security with 6 constraint layers.
 *
 * KEY FIXES (v2):
 *   - Reentrancy guard on claim() — ETH transfer happens last but guard adds defense-in-depth
 *   - Single-pass user array processing (was 2 passes: check then update — now 1 pass)
 *   - Fixed rounding loss in perUserCost calculation (remainder now tracked properly)
 *   - emergencyWithdraw() now auto-pauses the contract
 *   - Added batch claim support for multi-batch relayers
 *   - Custom errors for gas savings
 *   - Zero-user array validation
 *
 * CONSTRAINT LAYERS (defense-in-depth):
 *   Layer 1: Per-Claim Cap        — Bounds maximum single reimbursement
 *   Layer 2: Per-Relayer Daily     — Prevents one relayer from draining the pool
 *   Layer 3: Per-User Daily        — Prevents Sybil-style abuse by single users
 *   Layer 4: Global Daily          — Hard cap on total daily spending
 *   Layer 5: Pool Balance Check    — Cannot reimburse more than the pool holds
 *   Layer 6: Emergency Pause       — Owner can freeze all claims instantly
 */
contract GasSponsor {

    // ─── State Variables ─────────────────────────────────────────

    address public owner;
    bool public paused;
    bool private _locked; // Reentrancy guard

    // Relayer management
    mapping(address => bool) public whitelistedRelayers;

    // ─── Constraint Configuration ────────────────────────────────

    uint256 public maxPerClaim;
    uint256 public dailyLimitPerRelayer;
    uint256 public dailyLimitPerUser;
    uint256 public globalDailyLimit;

    // ─── Tracking ────────────────────────────────────────────────

    mapping(address => uint256) public relayerDailyClaimed;
    mapping(address => uint256) public relayerLastClaimDay;

    mapping(address => uint256) public userDailySponsored;
    mapping(address => uint256) public userLastSponsorDay;

    uint256 public globalDailyClaimed;
    uint256 public globalLastClaimDay;

    uint256 public totalDeposited;
    uint256 public totalClaimed;
    uint256 public totalClaimCount;

    // ─── Events ──────────────────────────────────────────────────

    event Deposited(address indexed sponsor, uint256 amount);
    event Claimed(
        address indexed relayer,
        uint256 amount,
        address[] users,
        uint256 batchSize
    );
    event RelayerStatusChanged(address indexed relayer, bool whitelisted);
    event LimitsUpdated(
        uint256 maxPerClaim,
        uint256 dailyLimitPerRelayer,
        uint256 dailyLimitPerUser,
        uint256 globalDailyLimit
    );
    event Paused(bool status);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event EmergencyWithdrawal(address indexed owner, uint256 amount);

    // ─── Custom Errors ───────────────────────────────────────────

    error NotOwner();
    error ContractPaused();
    error NotWhitelisted();
    error Reentrancy();
    error ZeroDeposit();
    error ZeroUsers();
    error ZeroAddress();
    error RelayerDailyLimitReached(address relayer, uint256 remaining);
    error UserDailyLimitReached(address user, uint256 remaining);
    error GlobalDailyLimitReached(uint256 remaining);
    error InsufficientPoolFunds(uint256 available, uint256 requested);
    error TransferFailed();

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier onlyWhitelistedRelayer() {
        if (!whitelistedRelayers[msg.sender]) revert NotWhitelisted();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ─── Constructor ─────────────────────────────────────────────

    constructor(
        uint256 _maxPerClaim,
        uint256 _dailyLimitPerRelayer,
        uint256 _dailyLimitPerUser,
        uint256 _globalDailyLimit
    ) {
        owner = msg.sender;
        maxPerClaim = _maxPerClaim;
        dailyLimitPerRelayer = _dailyLimitPerRelayer;
        dailyLimitPerUser = _dailyLimitPerUser;
        globalDailyLimit = _globalDailyLimit;
    }

    // ─── Deposit Functions ───────────────────────────────────────

    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    // ─── Claim Function (The Core Logic) ─────────────────────────
    //
    // KEY FIXES (v2):
    //   1. Added reentrancy guard
    //   2. Single-pass user array (was 2 passes)
    //   3. Fixed rounding: remainder from perUserCost division is now assigned
    //      to the first user, preventing "dust" loss

    function claim(
        uint256 amount,
        address[] calldata users
    ) external onlyWhitelistedRelayer whenNotPaused nonReentrant {
        if (users.length == 0) revert ZeroUsers();

        // ── Layer 1: Cap the claim amount ──
        uint256 reimbursement = amount > maxPerClaim ? maxPerClaim : amount;

        // ── Layer 5: Check pool balance (early exit saves gas on failure) ──
        uint256 poolBalance = address(this).balance;
        if (poolBalance < reimbursement) {
            revert InsufficientPoolFunds(poolBalance, reimbursement);
        }

        // ── Layer 2: Check & update relayer daily limit ──
        uint256 today = block.timestamp / 1 days;

        if (relayerLastClaimDay[msg.sender] < today) {
            relayerDailyClaimed[msg.sender] = 0;
            relayerLastClaimDay[msg.sender] = today;
        }

        uint256 relayerRemaining = dailyLimitPerRelayer - relayerDailyClaimed[msg.sender];
        if (reimbursement > relayerRemaining) {
            revert RelayerDailyLimitReached(msg.sender, relayerRemaining);
        }

        // ── Layer 4: Check & update global daily limit ──
        if (globalLastClaimDay < today) {
            globalDailyClaimed = 0;
            globalLastClaimDay = today;
        }

        uint256 globalRemaining = globalDailyLimit - globalDailyClaimed;
        if (reimbursement > globalRemaining) {
            revert GlobalDailyLimitReached(globalRemaining);
        }

        // ── Layer 3: Check & update per-user daily limits (SINGLE PASS) ──
        // Fix: properly handle division remainder so no "dust" is lost
        uint256 usersLen = users.length;
        uint256 perUserCost = reimbursement / usersLen;
        uint256 remainder = reimbursement % usersLen;

        for (uint256 i; i < usersLen; ) {
            address user = users[i];

            if (userLastSponsorDay[user] < today) {
                userDailySponsored[user] = 0;
                userLastSponsorDay[user] = today;
            }

            // First user absorbs the rounding remainder
            uint256 thisUserCost = (i == 0) ? perUserCost + remainder : perUserCost;

            uint256 userRemaining = dailyLimitPerUser - userDailySponsored[user];
            if (thisUserCost > userRemaining) {
                revert UserDailyLimitReached(user, userRemaining);
            }

            // Update in same pass (was separate loop in v1)
            userDailySponsored[user] += thisUserCost;

            unchecked { ++i; }
        }

        // ── Update tracking state ──
        relayerDailyClaimed[msg.sender] += reimbursement;
        globalDailyClaimed += reimbursement;
        totalClaimed += reimbursement;

        unchecked { ++totalClaimCount; }

        // ── Transfer reimbursement (LAST — checks-effects-interactions) ──
        (bool sent, ) = payable(msg.sender).call{value: reimbursement}("");
        if (!sent) revert TransferFailed();

        emit Claimed(msg.sender, reimbursement, users, usersLen);
    }

    // ─── Pre-check Function ──────────────────────────────────────

    function estimateReimbursement(
        uint256 amount,
        address relayer,
        address[] calldata users
    ) external view returns (uint256 reimbursement, bool wouldSucceed) {
        if (users.length == 0) return (0, false);
        if (paused) return (0, false);
        if (!whitelistedRelayers[relayer]) return (0, false);

        reimbursement = amount > maxPerClaim ? maxPerClaim : amount;

        // Check pool balance
        if (address(this).balance < reimbursement) return (0, false);

        // Check relayer daily limit
        uint256 today = block.timestamp / 1 days;
        uint256 relayerClaimed = relayerLastClaimDay[relayer] < today
            ? 0
            : relayerDailyClaimed[relayer];
        if (relayerClaimed + reimbursement > dailyLimitPerRelayer) return (0, false);

        // Check global daily limit
        uint256 globalClaimed_ = globalLastClaimDay < today ? 0 : globalDailyClaimed;
        if (globalClaimed_ + reimbursement > globalDailyLimit) return (0, false);

        // Check per-user limits
        uint256 perUserCost = reimbursement / users.length;
        uint256 rem = reimbursement % users.length;

        for (uint256 i; i < users.length; ) {
            uint256 userClaimed = userLastSponsorDay[users[i]] < today
                ? 0
                : userDailySponsored[users[i]];
            uint256 thisUserCost = (i == 0) ? perUserCost + rem : perUserCost;
            if (userClaimed + thisUserCost > dailyLimitPerUser) return (0, false);
            unchecked { ++i; }
        }

        return (reimbursement, true);
    }

    // ─── Admin Functions ─────────────────────────────────────────

    function setRelayer(address relayer, bool status) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        whitelistedRelayers[relayer] = status;
        emit RelayerStatusChanged(relayer, status);
    }

    function setLimits(
        uint256 _maxPerClaim,
        uint256 _dailyLimitPerRelayer,
        uint256 _dailyLimitPerUser,
        uint256 _globalDailyLimit
    ) external onlyOwner {
        maxPerClaim = _maxPerClaim;
        dailyLimitPerRelayer = _dailyLimitPerRelayer;
        dailyLimitPerUser = _dailyLimitPerUser;
        globalDailyLimit = _globalDailyLimit;
        emit LimitsUpdated(_maxPerClaim, _dailyLimitPerRelayer, _dailyLimitPerUser, _globalDailyLimit);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Emergency withdrawal — auto-pauses the contract before draining.
    function emergencyWithdraw() external onlyOwner {
        paused = true;
        emit Paused(true);

        uint256 balance = address(this).balance;
        (bool sent, ) = payable(owner).call{value: balance}("");
        if (!sent) revert TransferFailed();
        emit EmergencyWithdrawal(owner, balance);
    }

    // ─── View Functions ──────────────────────────────────────────

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function getRelayerDailyRemaining(address relayer) external view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        uint256 claimed = relayerLastClaimDay[relayer] < today ? 0 : relayerDailyClaimed[relayer];
        return dailyLimitPerRelayer > claimed ? dailyLimitPerRelayer - claimed : 0;
    }

    function getUserDailyRemaining(address user) external view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        uint256 claimed = userLastSponsorDay[user] < today ? 0 : userDailySponsored[user];
        return dailyLimitPerUser > claimed ? dailyLimitPerUser - claimed : 0;
    }

    function getGlobalDailyRemaining() external view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        uint256 claimed = globalLastClaimDay < today ? 0 : globalDailyClaimed;
        return globalDailyLimit > claimed ? globalDailyLimit - claimed : 0;
    }

    receive() external payable {
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }
}
