# LP-in-a-box

Run your own GBX↔USDC liquidity gateway as a federation citizen. Your keys, your capital, your machine — the protocol takes nothing.

Files:
- `lp_gateway_main.py <port>` — public quote/utxos/broadcast/powtpl gateway (systemd service)
- `lp_daemon_main.py` — swap reactor (watches intents, executes)
- `lp_env.py` — every path and port comes from the environment
- `lp_pricing.py` — price from executed trades; any federation node works
- `lp_solana.py` — Solana leg helpers

Secrets are never in this repository: EVM/Solana keys load from your own local files referenced by environment variables.
