# Transparency — known facts and inherited limits

Everything below is declared deliberately. History is never rewritten:
installers pin commit SHAs and on-chain anchors depend on them, so the record
stays exactly as it happened, stated here in the open.

## Git history

- 313 commits total at the time of this declaration. 294 are authored as
  `GOLDBRIX-GBX <goldbrixgbx@protonmail.com>`; 19 early commits carry other
  author identities (`gideon@goldbrix.app`, `gbx@local`, GitHub noreply
  addresses, `dev@goldbrix.app`) from before the identity was consolidated.
- 218 commits carry a `+0200` timezone, 95 carry `+0000`. Commit timestamps
  reflect the machines they were made on, nothing more.

## On-chain anchors

- Releases are anchored as `GBX:R:...` OP_RETURN transactions and verified by
  lineage (see RELEASE-LINEAGE.md). One malformed anchor exists historically
  (`GBX:R:tools-v1:000...0`, tx `8306cb37...`): it does not parse as a valid
  release anchor and is inert by design. The valid `tools-v1` anchor is tx
  `379ab503...`.

## Permanent archive

- The public source is permanently stored on Arweave and anchored on-chain
  (see ARWEAVE.md). Two duplicate `GBX:ARW:` anchor transactions exist due to
  a repeated broadcast; they carry identical messages and are harmless.

## Derived-data limits (declared, not hidden)

- The L1 side of the trade index is rebuilt identically from the chain by any
  node. The external leg (EVM/Solana settlement logs) depends on how much
  history each node's public RPC endpoints serve; a node that joins late may
  derive a shorter external history. Operators can configure deeper-history
  RPCs and rebuild. Money settlement never depends on this index — it is a
  read-side convenience.
- Third-party nodes run the version they installed until their operator
  applies an anchored release; the verifier reports the state publicly in
  `/gbx-node-info`.

## Inherited code

- Vendored third-party libraries and standard cryptographic constants are kept
  verbatim, as renaming them would break compatibility and auditability.
  Production database field names predating current naming stay unchanged for
  the same reason.
