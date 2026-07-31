# GBX Read API + Indexer

Run your own public read endpoint for the GBX chain. Wallets using
multi-node quorum reads can add your endpoint to their node list: more
independent endpoints means a stronger network.

Keyless by design. This service only reads your own chain and relays raw
transactions; it holds nothing and signs nothing.

Requires: Node.js >= 18 and a synced goldbrix-core node.

```
GBX_CLI=/usr/local/bin/goldbrix-cli \
GBX_RPC_PORT=8332 \
GBX_DATADIR=/var/lib/goldbrix \
node read-api.js
```

The indexer (`gbx-indexer.js`) builds a local SQLite address index from
your own node. No third party is involved at any point.

## Routes

**Chain and addresses**

| Route | Returns |
|---|---|
| `/api/status` | height, best hash, sync state |
| `/api/utxos/<address>` | spendable outputs |
| `/api/address/<address>` | balance, totals, maturity |
| `/api/activity/<address>` | transaction history |
| `/api/broadcast` | relay a signed raw transaction |
| `/api/peers` | peers this node sees |

**Launchpad tokens**

| Route | Returns |
|---|---|
| `/api/token-registry` | every coin known to the index |
| `/api/token/<id>` | one coin: metadata, supply, state |
| `/api/curves`, `/api/curves/<id>` | bonding curve reserves |
| `/api/pools`, `/api/pools/<id>` | AMM pool reserves after graduation |
| `/api/trades/<id>` | executed trades for a coin |
| `/api/candles/<id>` | OHLC candles |
| `/api/coin-stats/<id>` | price, volume, holders |
| `/api/my-coins/<pubkey>` | holdings and operations for one key |
| `/api/leaderboard` | coins ranked by on-chain activity |
| `/api/stats24` | 24h network activity |

**GBX itself**

| Route | Returns |
|---|---|
| `/api/gbx/stats` | price and volume for GBX |
| `/api/gbx/candles` | OHLC candles for GBX |
| `/api/gbx/trades` | executed GBX trades |

**Registries and burns**

| Route | Returns |
|---|---|
| `/api/node-registry` | nodes announced on-chain (`GBX:NODE:`) |
| `/api/lp-registry` | liquidity providers announced on-chain (`GBX:LP:`) |
| `/api/htlc-registry` | HTLC endpoints announced on-chain (`GBX:HTLC:`) |
| `/api/burns` | burned GBX, measured from your own chain |
| `/api/announcement` | current on-chain announcement, if any |

Serve these over HTTPS with CORS enabled, then announce your endpoint:

```bash
node node-registry/announce-node.js https://your-node.example
```

See [../docs/RUN-NODE-CADDY.md](../docs/RUN-NODE-CADDY.md) for a reference
web server configuration.
