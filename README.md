# GoldBrix Tools

Operator tooling for the GoldBrix (GBX) network. Everything here is keyless or non-custodial — nothing in this repository can hold or move funds.

| Component | What it does |
|---|---|
| `pool/` | Stratum mining pool, **solo non-custodial** mode: the coinbase of every block pays the miner's own address directly. Pool fee: **0** (code-is-law). Live: `stratum+tcp://goldbrix.app:3333`, stats at [/pool-info](https://goldbrix.app/pool-info) |
| `watchtower/` | Keyless public watchtower. Anyone can run it to record network liveness, binary integrity (SHA-256) and pool fee history. Third-party proof-of-autonomy. |
| `node-info/` | Health endpoint served by every node: height, best hash, and the SHA-256 of the binary actually running. |
| `docs/MINING.md` | How to mine GBX, step by step, from zero. |

Core node source: [goldbrix-core](https://github.com/GOLDBRIX-GBX/goldbrix-core) · Run a node: [guide](https://goldbrix.app/run-node) · Verified release binaries: [downloads](https://goldbrix.app/downloads/SHA256SUMS-v30-gbx-7.txt)

## Run the pool against your own node

```
cp pool/.env.example pool/.env   # point it at your node RPC
node pool/stratum/server.js
```

Requires Node.js >= 18 and a synced goldbrix-core node with RPC cookie auth. No database setup needed for solo mode.

## License

MIT

## Release anchors

Every release is anchored on-chain (OP_RETURN). Spec + verification: [docs/RELEASE-ANCHOR.md](docs/RELEASE-ANCHOR.md). Publish tool: `anchor-release.js`.
