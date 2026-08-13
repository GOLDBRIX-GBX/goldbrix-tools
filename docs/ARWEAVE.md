# Permanent source archive (Arweave)

The complete public source of the project is stored permanently on Arweave
and anchored on the GBX chain. Neither the founder nor anyone else can alter
or remove it. Any git hosting is a mirror; the chain plus Arweave are the
source of truth.

## The archives

| Release | Arweave TXID | SHA-256 |
|---|---|---|
| goldbrix-tools `tools-v1` (commit `f55827e7...`) | `qY-FxgAr8ryiNixQQpQL8225dnZHJTL760Ef2GYS-do` | `be392ca249d6fd31d731583ac336cc345c719f40e1cc326559851fd7df45b994` |
| goldbrix-core `core-v31a` (commit `15b874ec...`) | `bxcHl1USGOmtF-H1UougcUsLw1Y37H-beLxair3btGM` | `2c58bca3e5f86758c790ddd38e78e4ee01cd78791dd25c164cb700f66b06edd6` |

On-chain anchors (OP_RETURN, spent from the release lineage — see
RELEASE-LINEAGE.md): `GBX:ARW:tools-v1:<txid>` in GBX tx `c7e81bd3...` and
`GBX:ARW:core-v31a:<txid>` in GBX tx `bc0b7738...`. Duplicate anchor
transactions with identical messages exist (`8508e7bd...`, `a131d3be...`);
they are redundant and harmless.

## Verify and rebuild from nothing

1. Read the `GBX:ARW:` anchors from any GBX node (or this document).
2. Download: `curl -L -o tools.tar.gz https://arweave.net/<tools-txid>`
   (any Arweave gateway works; the TXID is the content's identity).
3. Verify: `sha256sum tools.tar.gz` must equal the anchored SHA-256.
4. Unpack and run `run-node/install-node.sh` — a full node, the read API,
   the indexes and the wallet app, with no dependency on the founder,
   any server, or any specific hosting.
5. The core archive rebuilds the node binary reproducibly (see the Guix
   guide inside it); the resulting chain state is identical on every
   machine that replays the same chain.

The tarballs are `git archive` outputs of the anchored tags: anyone with a
mirror of the repository at the same tag reproduces the same bytes and the
same SHA-256.
