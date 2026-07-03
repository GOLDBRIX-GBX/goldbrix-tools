# GBX Read API + Indexer

Run your own public read endpoint for the GBX chain. Wallets using multi-node quorum reads can add your endpoint to their node list — more independent endpoints = stronger network.

Requires: Node.js >= 18 + a synced goldbrix-core node.

```
GBX_CLI=/usr/local/bin/goldbrix-cli GBX_RPC_PORT=8332 GBX_DATADIR=$HOME/.bitcoin node read-api.js
```

Routes: `/api/status`, `/api/utxos/<addr>`, `/api/address/<addr>`, `/api/broadcast`. The indexer (`gbx-indexer.js`) builds a local SQLite address index from your own node — no third party involved. Keyless: this service only reads the chain and relays raw transactions.
