# LP Federation (lps.json)

Anyone with USDC can run an independent GBX↔USDC liquidity provider.
The app discovers LPs via `lps.json` (same model as `nodes.json`) and
routes to the best quote. Liquidity comes from the MARKET, not from a
single operator.

## Required endpoints (HTTPS, CORS enabled)

| Endpoint | Method | Purpose |
|---------|--------|---------|
| `/lp-info` | GET | identity: pubkeys, addresses, fee_bps, reserves, price |
| `/quote` | GET | price quote (buy/sell), must include cap_gbx, breaker |
| `/intent` | POST | HTLC swap intent (atomic, non-custodial) |
| `/sell-guard/<pubkey>` | GET | pre-check before L1 lock |

All swaps are HTLC atomic swaps — the LP never custodies user funds.
A malicious LP can only refuse to trade; it cannot steal.

## lps.json format

```json
{
  "version": 1,
  "lps": [
    {
      "name": "founder-lp",
      "base_url": "https://goldbrix.app/lp",
      "info_url": "https://goldbrix.app/lp-info",
      "chains": ["base", "arbitrum", "solana"],
      "fee_bps": 0
    }
  ]
}
```

## How the app selects an LP (spec — active when >1 LP exists)

1. Fetch `lps.json`, query `/quote` on each listed LP.
2. Drop LPs with breaker active, unreachable, or quote older than 30s.
3. Route to the best effective price after spread/fee.
4. The HTLC flow is identical regardless of LP — funds stay safe.

## Joining as an LP

Run the gateway stack (open source, this repo) or any implementation
matching this spec, then submit your entry for `lps.json` via PR or
publish your own lps.json mirror. At handover (R), the founder LP shuts
down and the app continues on third-party LPs.
