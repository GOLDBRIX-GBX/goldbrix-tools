# L2 Token Indexing & State Replay (GBX:OP:*)

All launchpad token operations are published on-chain as OP_RETURN outputs.
This document specifies how a third party can rebuild L2 state from the
chain alone, and what the known limits are.

## Operation formats

```
GBX:OP:CREATE:<ticker>:<supply>:<decimals>:<metadata-hash>
GBX:OP:MINT:<ticker>:<amount>:<recipient-suffix>
GBX:OP:XFER:<ticker>:<amount>:<recipient-suffix>
GBX:OP:BURN:<ticker>:<amount>
GBX:OP:GRADUATE:<ticker>:<gbx-reserve>:<token-reserve>
GBX:OP:STATE:<ticker>:<reserve-gbx>:<holders>:<merkle16>
```

- `recipient-suffix` — last 20 chars of the bn1 address (privacy-preserving)
- `merkle16` — first 16 hex chars of SHA-256 over the sorted balance list
  (`address:balance`, 8 decimals, one per line, sorted by address)
- `STATE` checkpoints are published by a daemon whenever a token's state
  changes (curve reserve, holder count, balance set).

## What a third party can rebuild from chain alone

- Full operation history per token (create/mint/burn/xfer/graduate)
- Circulating supply per token = sum(MINT) - sum(BURN)
- Total burned GBX (all fees go to the unspendable burn address)
- Curve reserve and holder count at every STATE checkpoint
- Integrity of any claimed balance set: recompute merkle16 and compare
  against the latest on-chain STATE checkpoint

## Known limits (honest)

- Recipients are truncated (20-char suffix): full addresses are not
  recoverable from chain alone. A full balance snapshot must be obtained
  from any API (or peer) and verified against merkle16.
- BURN has no source address on-chain.
- The STATE checkpoint cadence is best-effort (daemon, max 10 tx/run).

## Verify a STATE checkpoint

```bash
# fetch balances from any source, format address:balance (8 decimals), sort,
sha256sum <<(sorted list) # first 16 hex must equal merkle16 from chain
```
