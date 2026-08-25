# GoldBrix Tools

> **Project finalized.** The founder has exited: treasury burned,
> release keys destroyed, Solana program immutable — all verifiable
> on-chain. See [docs/GATE-R.md](docs/GATE-R.md).

Operator tooling for the GoldBrix (GBX) network. Everything here is keyless
or non-custodial: nothing in this repository can hold or move user funds.

| Component | What it does |
|---|---|
| `client/` | The wallet and trading app (PWA, also shipped as the Android build). Reads the chain through the federated layer, signs locally, never uploads a key. |
| `read-api/` | Public read endpoint plus the address indexer. Serves UTXOs, balances, history, curves, pools, candles and the on-chain registries from your own node. |
| `read-router/` | `gbx-read.js`: multi-node reads with failover and quorum on critical fields. A client that loses one node keeps working on the next. |
| `token-index/` | Token state rebuilt purely from the chain: holdings derived from `GBX:C` operations minus spent token UTXOs. Reorg-safe, reconstructible by anyone. |
| `node-registry/` | On-chain discovery: announce and scan `GBX:NODE:`, `GBX:LP:` and `GBX:HTLC:` endpoints. No central list. |
| `lp-box/` | Run your own GBX<->USDC liquidity gateway. Your keys, your capital, your machine. See [docs/LP-FEDERATION.md](docs/LP-FEDERATION.md). |
| `pool/` | Stratum mining pool, **solo non-custodial**: the coinbase of every block pays the miner's own address directly. Pool fee **0** (code-is-law). |
| `miner-box/` | One-command miner setup: payout wallet plus automatic daily UTXO consolidation. |
| `run-node/` | `install-node.sh`: full node installation, verifies the release SHA-256 before running anything. |
| `node-info/` | Health endpoint served by every node: height, best hash, and the SHA-256 of the binary actually running. |
| `watchtower/` | Keyless public watchtower. Anyone can record network liveness, binary integrity and pool fee history. Third-party proof of autonomy. |
| `docs/` | Protocol and operator specifications (see below). |

## Documentation

| Document | Subject |
|---|---|
| [docs/INDEXING.md](docs/INDEXING.md) | On-chain declaration formats; rebuild all token state from the chain alone |
| [docs/LP-FEDERATION.md](docs/LP-FEDERATION.md) | The full liquidity gateway contract, for anyone running an LP |
| [docs/MINING.md](docs/MINING.md) | How to mine GBX, step by step, from zero |
| [docs/RELEASE-ANCHOR.md](docs/RELEASE-ANCHOR.md) | How releases are anchored on-chain and how to verify one |
| [docs/RUN-NODE-CADDY.md](docs/RUN-NODE-CADDY.md) | Reference web server configuration for a public node |

## Get the app

The wallet in `client/` is what people actually run. It needs no build step: any
node that follows [docs/RUN-NODE-CADDY.md](docs/RUN-NODE-CADDY.md) serves it over
HTTPS, and the Android build of the same code is published on the
[GitHub Release](https://github.com/GOLDBRIX-GBX/goldbrix-core/releases/tag/v31-gbx-federation). Verify its SHA-256 against `/version.json`,
which every node serves from its own copy, and check the release anchor on-chain
([docs/RELEASE-ANCHOR.md](docs/RELEASE-ANCHOR.md)).

Core node source: [goldbrix-core](https://github.com/GOLDBRIX-GBX/goldbrix-core)
Verified release binaries: [GitHub Release](https://github.com/GOLDBRIX-GBX/goldbrix-core/releases/tag/v31-gbx-federation)

## Run the pool against your own node

```
cp pool/.env.example pool/.env   # point it at your node RPC
node pool/stratum/server.js
```

Requires Node.js >= 18 and a synced goldbrix-core node with RPC cookie
auth. No database setup is needed for solo mode. Any node operator can
expose their own pool; miners are free to point anywhere.

## License

Copyright (C) 2026 The GOLDBRIX Project (GBX)

GPL-3.0-or-later - see [COPYING](COPYING). Anyone may read, rebuild and
verify this code; any distributed modification must stay open under the
same license.

## Release anchors

Every release is anchored on-chain (OP_RETURN). Spec and verification
steps: [docs/RELEASE-ANCHOR.md](docs/RELEASE-ANCHOR.md). Publish tool:
`anchor-release.js`.
