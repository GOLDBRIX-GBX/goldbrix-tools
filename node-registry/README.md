# GBX On-Chain Node Registry

Decentralized endpoint discovery over OP_RETURN. No central list, no
maintainer, no URL that anyone has to keep alive.

```
GBX:NODE:<https-url>    read endpoint of a node
GBX:LP:<https-url>      liquidity provider gateway
GBX:HTLC:<https-url>    HTLC contract endpoint
```

Anti-spam is economic: the operator pays the L1 fee to announce their own
entry. Entries stay valid for a liveness window of 200,000 blocks
(~7 days) and expire unless re-announced, so a dead endpoint removes
itself.

## Tools

- `announce-node.js` - publish your read endpoint (needs a wallet with a
  small amount of GBX for the fee).
- `announce-lp.js` - publish your liquidity gateway.
- `announce-htlc.js` - publish an HTLC contract endpoint.
- `scanner.js` - keyless and read-only; scans new blocks and keeps state
  in `node-registry.json`.

`read-api` serves the result at `/api/node-registry`, and the app merges
it as one discovery source among several.

Discovery order: entry points shipped in the client, then `nodes.json`
mirrors, then the on-chain registry. Any one path alive is enough to reach
the network.
