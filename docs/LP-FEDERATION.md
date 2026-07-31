# LP Federation

Anyone holding USDC can run an independent GBX<->USDC liquidity provider.
Clients discover LPs from the on-chain registry (`GBX:LP:<https-url>`) and
from `lps.json`, then route to the best quote. Liquidity comes from the
market, not from a single operator.

Every swap is an HTLC atomic swap. The LP never custodies user funds: a
malicious or broken LP can refuse to trade, but it cannot take anything.

Reference implementation: `lp-box/` (this repository). Any implementation
matching the contract below is a first-class citizen of the federation.

## Transport

- HTTPS with CORS enabled (`Access-Control-Allow-Origin: *`) on GET and
  POST. Clients are browsers and mobile apps served from other origins.
- Requests and responses are JSON.
- Endpoints below are relative to the gateway base URL.

## GET endpoints

| Endpoint | Purpose |
|---|---|
| `/lp-info` | identity: chains served, addresses, fee_bps, reserves, price, breaker state |
| `/quote` | price quote for buy or sell; must include `cap_gbx` and breaker state |
| `/sell-guard/<pubkey>` | pre-check before the user locks GBX on L1; returns the real wait in `retry_after_s` |
| `/utxos/<address>` | UTXOs for an address, so a client without a node can build a transaction |
| `/utxo-status` | whether a given outpoint is still unspent |
| `/swap/<swap_id>` | current state of one swap |
| `/gbx-price` | GBX price used by this LP (also `/onramp/gbx-price`) |
| `/height` | chain height this LP sees |
| `/powtpl` | keyless proof-of-work template |

## POST endpoints

| Endpoint | Required fields |
|---|---|
| `/intent` | `direction`, `gbx_val`, `hashlock`, `refund_pubkey`, `sol_user_pubkey` |
| `/broadcast` | `rawtx` |
| `/sol-prepare` | `swap_id`, `hashlock`, `amount`, `user_pubkey` |
| `/sol-submit` | `swap_id`, `hashlock`, `gbx_amount`, `tx_signed_b64` |
| `/sol-prepare-claim` | `swap_id`, `preimage`, `user_pubkey` |
| `/sol-submit-claim` | `swap_id`, `tx_signed_b64` |
| `/sol-relay-refund` | `swap_id`, `sender_ata` |
| `/evm-relay-claim` | `hashlock`, `preimage` |

## Gasless claim and refund are not optional

A user who buys GBX with USDC may hold no SOL and no ETH. Without a relay
they cannot claim what they bought, and cannot recover a lock that
expired. Their money would sit in the contract until they fund a wallet on
a chain they never wanted to use.

`/sol-relay-refund` and `/evm-relay-claim` exist so the LP pays that gas.
This is safe by construction, not by trust:

- On Solana the program enforces `sender_ata.owner == swap.sender`, so a
  refund can only ever return the funds to the account that locked them.
  The relay is a gas payer and nothing more.
- On EVM the claim requires the preimage; the relay cannot invent one, and
  the contract pays out to the party fixed at lock time.
- The gateway reads swap state from the chain, never from the caller: an
  unexpired, already claimed or already refunded lock is refused.

An LP that omits these two endpoints will strand users who have no native
gas token. Implement them.

## Discovery

Announce your gateway on-chain, once, from your own wallet:

```bash
node node-registry/announce-lp.js https://your-lp.example/lp
```

This publishes `GBX:LP:<https-url>` in an OP_RETURN. You pay the L1 fee
yourself, which is the whole anti-spam mechanism. Entries expire after a
liveness window of 200,000 blocks (~7 days) unless re-announced, so a dead
LP disappears from the federation on its own.

`lps.json` remains a supplementary source for clients that have not yet
scanned the registry. Neither source is authoritative over the other: a
client that can reach either one can trade.

## How a client selects an LP

1. Collect LPs from the on-chain registry and from `lps.json`.
2. Query `/lp-info` and `/quote` on each, with a short timeout.
3. Drop any LP that is unreachable, has its breaker active, or returns a
   stale quote.
4. Route to the best effective price after fee and spread.
5. Retry once on another healthy LP if the first one fails mid-flow.

The HTLC flow is identical whichever LP is chosen, so switching providers
mid-session cannot put funds at risk.

## Running one

`lp-box/install-lp.sh` installs the gateway and the swap daemon on your own
machine. It asks you for six values that are yours alone: an encryption
password and your payout addresses on Base, Arbitrum and Solana (plus the
Solana token account). No key, no secret and no fixed URL comes from
anyone else.

At handover the founder's LP shuts down. The app continues on whatever LPs
the registry lists that day.
