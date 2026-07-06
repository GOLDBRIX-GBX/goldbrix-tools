# Mining GBX — from zero

GBX uses **SHA-256d** proof-of-work. Mining is permissionless: no registration, no whitelist, no account. Your GBX address **is** your mining account.

## 1. Get a GBX address

Create a wallet at [goldbrix.app](https://goldbrix.app) (or run your own node and `getnewaddress`). Your address starts with `bn1`. **You keep the keys. Nobody else can touch your rewards.**

## 2. Get a miner

Any stratum-compatible SHA-256d miner works. Example with cpuminer:

```
./cpuminer -a sha256d -o stratum+tcp://goldbrix.app:3333 -u bn1YOURADDRESS.worker1 -p x
```

Login format: `bn1address.workername` (worker name is anything you like).

**Difficulty (vardiff):** the pool auto-adjusts share difficulty per connection (target ~1 share/8s, retarget ~45s), so remote miners are no longer rejected. You may optionally set a starting difficulty via the password field: `-p d=1000` (any positive number). Leave it as `-p x` to let vardiff pick automatically.

## 3. What happens when you find a block

The pool runs in **solo non-custodial** mode:

- The block's coinbase pays **your address directly** — the reward never passes through the pool.
- Pool fee is **0**. Verify live: [goldbrix.app/pool-info](https://goldbrix.app/pool-info) (`fee_bps: 0`).
- Current reward: **0.25 GBX per block**. Rewards can be spent after **100 confirmations** (standard coinbase maturity).

## 4. Check your rewards

Search your address in the [explorer](https://explorer.goldbrix.app) or open your wallet at goldbrix.app.

## 5. Trust nothing, verify everything

- Node binaries are **reproducible** (Guix builds). SHA-256 sums: [downloads](https://goldbrix.app/downloads/SHA256SUMS-v30-gbx-7.txt)
- Every node exposes `/gbx-node-info` with the SHA-256 of the binary it is actually running.
- Run the [watchtower](../watchtower/watchtower.py) to record it all yourself.

## 6. Maximum sovereignty (optional)

Run your own node ([guide](https://goldbrix.app/run-node)) and point this pool software at it — then you mine against your own consensus, on your own hardware, with zero third parties.
