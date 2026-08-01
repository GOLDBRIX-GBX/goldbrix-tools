// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
// EIP-3009, native to USDC: the token moves on the holder's signature alone,
// so the person swapping never needs the chain's gas token.
interface IERC3009 {
    function receiveWithAuthorization(
        address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external;
}

/// A cross-chain HTLC for USDC that never takes custody.
/// Immutable: no owner, no admin, no upgrade path, no selfdestruct. Once
/// deployed, nobody can change what it does or where the money can go.
/// The hashlock is SHA-256, the same primitive the GBX side uses (OP_SHA256),
/// so one preimage unlocks both legs of a swap.
/// Two paths let someone swap without holding gas: lockFor takes a signature
/// under this contract's own EIP-712 domain, lockAuth takes the USDC EIP-3009
/// signature directly. In both, the signer is the swap's sender: whoever
/// submits the transaction pays the gas and can do nothing else.
contract HashedTimelockERC20v2 {
    struct Swap {
        address sender; address receiver; address token;
        uint256 amount; bytes32 hashlock; uint256 timelock;
        bool claimed; bool refunded;
    }
    mapping(bytes32 => Swap) public swaps;
    mapping(address => uint256) public nonces; // one per user, so a signature cannot be replayed

    // This contract's own EIP-712 domain, not the token's.
    bytes32 public immutable DOMAIN_SEPARATOR;
    // LockFor(address user,address receiver,address token,uint256 amount,bytes32 hashlock,uint256 timelock,uint256 nonce,uint256 deadline)
    bytes32 public constant LOCKFOR_TYPEHASH =
        keccak256("LockFor(address user,address receiver,address token,uint256 amount,bytes32 hashlock,uint256 timelock,uint256 nonce,uint256 deadline)");

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("GoldBrix HTLC")), keccak256(bytes("2")),
            block.chainid, address(this)
        ));
    }

    event Locked(bytes32 indexed id, address indexed sender, address indexed receiver,
                 address token, uint256 amount, bytes32 hashlock, uint256 timelock);
    event Claimed(bytes32 indexed id, bytes preimage);
    event Refunded(bytes32 indexed id);

    function _store(address sender, address receiver, address token, uint256 amount,
                    bytes32 hashlock, uint256 timelock) internal returns (bytes32 id) {
        require(amount > 0, "amount=0");
        require(receiver != address(0), "receiver=0");
        require(timelock > block.timestamp, "timelock past");
        id = keccak256(abi.encode(sender, receiver, token, amount, hashlock, timelock, block.chainid, address(this)));
        require(swaps[id].sender == address(0), "exists");
        swaps[id] = Swap(sender, receiver, token, amount, hashlock, timelock, false, false);
        emit Locked(id, sender, receiver, token, amount, hashlock, timelock);
    }

    // --- direct path: the sender submits and pays the gas ---
    function lock(address receiver, address token, uint256 amount, bytes32 hashlock, uint256 timelock)
        external returns (bytes32 id) {
        id = _store(msg.sender, receiver, token, amount, hashlock, timelock);
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "transferFrom fail");
    }

    // --- signed path: sender signs under the domain above, anyone may submit; USDC moves by a prior approval ---
    function lockFor(
        address user, address receiver, address token, uint256 amount,
        bytes32 hashlock, uint256 timelock, uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external returns (bytes32 id) {
        require(block.timestamp <= deadline, "expired");
        {
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
                keccak256(abi.encode(
                    LOCKFOR_TYPEHASH, user, receiver, token, amount,
                    hashlock, timelock, nonces[user], deadline))));
            require(ecrecover(digest, v, r, s) == user && user != address(0), "bad sig");
        }
        nonces[user] += 1;
        id = _store(user, receiver, token, amount, hashlock, timelock);
        require(IERC20(token).transferFrom(user, address(this), amount), "transferFrom fail");
    }

    // --- fully gasless path: USDC moves on its own EIP-3009 signature, with no approval step at all ---
    function lockAuth(
        address user, address receiver, bytes32 hashlock, uint256 timelock,
        address token, uint256 amount,
        uint256 validAfter, uint256 validBefore, bytes32 authNonce,
        uint8 v, bytes32 r, bytes32 s
    ) external returns (bytes32 id) {
        id = _store(user, receiver, token, amount, hashlock, timelock);
        // The token itself moves the funds from the sender into this contract.
        IERC3009(token).receiveWithAuthorization(
            user, address(this), amount, validAfter, validBefore, authNonce, v, r, s);
    }

    function claim(bytes32 id, bytes calldata preimage) external {
        Swap storage sw = swaps[id];
        require(sw.sender != address(0), "no swap");
        require(!sw.claimed && !sw.refunded, "done");
        require(sha256(preimage) == sw.hashlock, "bad preimage");
        sw.claimed = true;
        require(IERC20(sw.token).transfer(sw.receiver, sw.amount), "transfer fail");
        emit Claimed(id, preimage);
    }

    function refund(bytes32 id) external {
        Swap storage sw = swaps[id];
        require(sw.sender != address(0), "no swap");
        require(!sw.claimed && !sw.refunded, "done");
        require(block.timestamp >= sw.timelock, "too early");
        sw.refunded = true;
        require(IERC20(sw.token).transfer(sw.sender, sw.amount), "transfer fail");
        emit Refunded(id);
    }
}
