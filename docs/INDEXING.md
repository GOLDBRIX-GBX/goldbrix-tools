# On-Chain Token Indexing (GBX:* OP_RETURN)

Every launchpad operation is published on-chain as an OP_RETURN output.
This document specifies the exact byte layout of each declaration, so a
third party can rebuild the full L2 state from the chain alone, with no
API and no permission from anyone.

Reference implementation: `token-index/scanner.js` (keyless, read-only).

## Declaration formats

### Curve and pool operations - `GBX:C:`

```
'GBX:C:'(6) + op(1) + cid(32) + amount(8 BE) + tokens_out(8 BE) + pk(33)
= 88 bytes
```

| `op` | Meaning |
|---|---|
| `C` | create a coin (bonding curve opens) |
| `B` | buy on the curve |
| `S` | sell on the curve |
| `G` | graduate (curve closes, AMM pool opens) |
| `P` | pool buy (post-graduation AMM) |
| `Q` | pool sell (post-graduation AMM) |
| `R` | reserved marker, excluded from traded volume |

- `cid` - coin id, 32 bytes
- `amount`, `tokens_out` - big-endian unsigned, base units
- `pk` - 33-byte compressed public key of the actor

### Token transfer - `GBX:T:`

```
'GBX:T:'(6) + ver(1) + cid(32) + amount(8 BE) + pk_recipient(33)
```

Indexed as `T` on the sender side and `U` on the recipient side.

### Coin metadata - `GBX:M:`

```
v1: 'GBX:M:'(6) + ver=1(1) + cid(32) + tickerLen(1) + ticker + nameLen(1) + name
v2: 'GBX:M:'(6) + ver=2(1) + cid(32) + dLen(1) + desc + lLen(1) + links
```

Max 255 bytes (PUSHDATA1 limit). `desc` up to 150 UTF-8 bytes, `links` up
to 64. A declaration is not trusted on sight: only the coin creator's key
may set metadata for that `cid`.

### Coin logo - `GBX:L:`

```
'GBX:L:'(6) + ver=1(1) + cid(32) + idx(1) + total(1) + hash16(16) + dLen(1) + data(<=197)
= max 255 bytes per chunk
```

Up to 21 chunks (~4 KB WebP). `hash16` is the first 16 bytes of the
SHA-256 of the complete logo; a logo is accepted only once every chunk is
present and the reassembled bytes hash to `hash16`.

### Discovery registries

```
GBX:NODE:<https-url>    read endpoint of a node
GBX:LP:<https-url>      liquidity provider gateway
GBX:HTLC:<https-url>    HTLC contract endpoint
```

Anti-spam is economic: the operator pays the L1 fee to announce their own
entry. Entries expire after a liveness window of 200,000 blocks (~7 days)
unless re-announced. See `node-registry/`.

## What a third party can rebuild from the chain alone

- Every curve and pool operation per coin, in block order
- Curve reserve, virtual supply and price at any height
- AMM pool reserves after graduation
- Coin name, ticker, description, links and logo
- Total burned GBX (fees go to an unspendable address)
- The full node, LP and HTLC registries

None of the above requires an API. An index built this way is identical on
every machine that replays the same chain.

## Known limits (honest)

- `GBX:T:` carries the recipient public key, not a full address; deriving
  the address requires the same derivation the wallet uses.
- Burn outputs carry no source address on-chain.
- Metadata and logo declarations are ignored by consensus. They are client
  and index level only: an invalid declaration costs its author a fee and
  is discarded by every honest indexer.
- The trade index has two legs. The L1 leg is rebuilt identically from the
  chain by any node. The external leg (EVM/Solana settlement logs) only
  reaches as far back as the node's public RPC endpoints serve history, so a
  node that joins late may derive a shorter external history. Configuring
  deeper-history RPCs and rebuilding (`rm gbx-trades.db` + restart) recovers
  what those RPCs still serve. Money settlement never depends on this index.

## Rebuild the index yourself

```bash
GBX_BIN=/usr/local/bin/goldbrix-cli \
GBX_DATADIR=/var/lib/goldbrix \
GBX_TOKENIDX_DB=/var/lib/goldbrix/index/curve-mainnet.db \
GBX_SQLITE_MOD=/path/to/read-api/node_modules/better-sqlite3 \
node token-index/scanner.js --oneshot
```

Compare your result with any public endpoint. If they disagree, your own
chain is the authority.
