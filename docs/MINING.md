# Mining GBX — from zero

GBX uses **SHA-256d** proof-of-work. Mining is permissionless: no registration, no whitelist, no account. Your GBX address **is** your mining account.

## 1. Get a GBX address

Create a wallet in the GoldBrix app on any federation node (or run your own node and `getnewaddress`). Your address starts with `bn1`. **You keep the keys. Nobody else can touch your rewards.**

## 2. Get a miner

Any stratum-compatible SHA-256d miner works. Example with cpuminer:

```
# every federation node can expose its own solo pool on port 3333.
# Pick any live node from the federation (see the node registry) and use its hostname:
./cpuminer -a sha256d -o stratum+tcp://NODE_HOST:3333 -u bn1YOURADDRESS.worker1 -p x
```

Login format: `bn1address.workername` (worker name is anything you like).

**Difficulty (vardiff):** the pool auto-adjusts share difficulty per connection (target ~1 share/8s, retarget ~45s), so remote miners are no longer rejected. You may optionally set a starting difficulty via the password field: `-p d=1000` (any positive number). Leave it as `-p x` to let vardiff pick automatically.

## 3. What happens when you find a block

The pool runs in **solo non-custodial** mode:

- The block's coinbase pays **your address directly** — the reward never passes through the pool.
- Pool fee is **0** and the coinbase pays your address directly. Verify live on the pool's `/pool-info` endpoint (`fee_bps: 0`).
- Current reward: **0.25 GBX per block**. Rewards can be spent after **100 confirmations** (standard coinbase maturity).

## 4. Check your rewards

Search your address in the explorer of any federation node, or open your wallet in the app.

## 5. Merging your rewards before you spend them

Every block you find pays a **separate** output of 0.25 GBX. They never merge on
their own. After a few thousand blocks a wallet holds its balance in thousands of
tiny pieces, and a single transaction cannot carry enough of them to move a large
amount. The wallet reports the largest amount one transfer can move right now,
and that number shrinks as the pieces multiply.

The fix is to merge them into fewer, larger outputs. This is a normal transaction
from your wallet to your own address; nobody else can sign it and the coins never
leave your control.

If you run your own node with a wallet, [run-node/gbx-consolidate.sh](../run-node/gbx-consolidate.sh)
does it in batches:

```sh
GBX_DEST=<an address of your own wallet> ./gbx-consolidate.sh
```

It refuses to run if GBX_DEST is not an address the signing wallet owns, stops
when the number of outputs is already below the threshold, and caps how many
transactions it broadcasts per run. Defaults: 500 inputs per transaction, 100
confirmations minimum, threshold 200 outputs, 5 transactions per run, all
overridable by environment variable.

If your keys live only in the app, send the amount the wallet reports as the
current maximum to your own address, and repeat until the balance sits in a few
large pieces.

## 6. Trust nothing, verify everything

- Node binaries are **reproducible** (Guix builds). SHA-256 sums: the SHA256SUMS file on the canonical GitHub Release (goldbrix-core, v31-gbx-launchpad) — anchored on-chain.
- Every node exposes `/gbx-node-info` with the SHA-256 of the binary it is actually running.
- Run the [watchtower](../watchtower/watchtower.py) to record it all yourself.

## 7. Maximum sovereignty (optional)

Run your own node (the run-node guide ships inside the app on every federation node) and point this pool software at it — then you mine against your own consensus, on your own hardware, with zero third parties.
