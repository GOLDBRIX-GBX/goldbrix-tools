# GBX On-Chain Node Registry (IDEE C)
Decentralized node discovery via OP_RETURN `GBX:NODE:<https-url>`.
- Anti-spam: L1 fee (operator pays own announce) + liveness window 200k blocks (~7 days) — expire without re-announce.
- announce-node.js: operator publishes their node (needs wallet with small GBX for fee).
- scanner.js: keyless, read-only; scans new blocks, state in node-registry.json.
- read-api serves it at /api/node-registry; the app client (read-router) merges it as a discovery source.
Discovery chain: hardcoded -> nodes.json (site+GitHub) -> on-chain registry. Any one path alive is enough.
