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
| goldbrix-tools `tools-final` (commit `9216416c...`) | `nVkgMqVScD8iq5e5RyxxCzImsREJkKCR7Qs-VSj2kOc` | `368814f002bb0b21e8d78072dd3756323b0ade43b06c0a6a6c531ec0b3f6585a` |
| goldbrix-core `core-final` (commit `8f970aa4...`) | `xsVFhwVAkHyZwc7zT2X4Ml_Qhx8c9EofAk3tbizAhmc` | `bd5cdf3eed5c7ca314d19c22b2a5a50cbe8c6957ef255b44b822c3e6a330c5a2` |

On-chain anchors (OP_RETURN, spent from the release lineage — see
RELEASE-LINEAGE.md): `GBX:ARW:tools-v1:<txid>` in GBX tx `c7e81bd3...` and
`GBX:ARW:core-v31a:<txid>` in GBX tx `bc0b7738...`. Duplicate anchor
transactions with identical messages exist (`8508e7bd...`, `a131d3be...`);
they are redundant and harmless.

The final archives carry the current source and are anchored the same way:
`GBX:ARW:tools-final:<txid>` in GBX tx `8c783704...` and
`GBX:ARW:core-final:<txid>` in GBX tx `d8d800db...`. A tag may be anchored
more than once; a verifier keeps the anchor at the greatest block height, so
these supersede the earlier `tools-final` / `core-final` anchors, which
archived an installer pinned to the pre-federation binary.

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
