# Release lineage — how anchored releases are verified

Every goldbrix-tools release is a git tag (`tools-vN`) anchored on the GBX
chain as an OP_RETURN: `GBX:R:tools-<tag>:<commit-sha>`.

## What makes an anchor valid

An anchor is valid only through its **lineage**: walking the first input
(`vin[0]`) of the anchoring transaction backwards, transaction by transaction,
must reach the published lineage root — a coinbase output:

```
LINEAGE ROOT (coinbase):
6aef6c971eac85c50990de354f5bb8386ff264ae09616c74c7a3949e66950400
```
Nobody can produce a valid anchor without spending an output of that unbroken
line, which requires the release key. There is no fixed release address —
outputs rotate; only the lineage matters. When the release key is destroyed,
the line is frozen by math: no new valid anchors can ever appear, and every
node's verifier keeps reporting `up_to_date` forever.

Anchors that do not parse as `tools-<tag>:<40-hex-commit>` or whose lineage
does not reach the root are ignored and logged. One such malformed anchor
exists historically (`GBX:R:tools-v1:000...0`, tx `8306cb37...`) — it is
inert by design.

## Components

- `release-check/release-check.js` + daily timer — keyless verifier. Scans the
  node's OWN chain, validates lineage, and reports `none_anchored` /
  `up_to_date` / `ahead_of_anchor` / `update_available` in `/gbx-node-info`.
  It never applies anything. `ahead_of_anchor` means this node's HEAD is a
  descendant of the anchored commit: it carries the anchored release plus
  later work, and applying the tag would roll that work back. An anchor this
  repo has never fetched is reported as `update_available`, not as ahead.
  The verdict describes git metadata, so the report also carries `tree_clean`
  and `tree_changed`: the tracked files that differ between the worktree and
  HEAD. A running copy installed by copying files rather than by checking out
  can drift — code moves while `.git` stays frozen, or worse, metadata reaches
  a newer tag while the files stay old, and the verdict then reads `up_to_date`
  over stale code. Local modifications are legitimate and never suppress the
  verdict; they are reported next to it so the operator can see both truths.
  **The running copy needs its `.git` directory, not only its files.** A sync
  that excludes `.git` leaves the verifier describing a version the node is not
  running; `no tools-* tag at HEAD` in the log is the first symptom.
- `release-check/apply-release.sh <tag>` — the operator's deliberate action.
  Verifies the tag's commit against the CHAIN (a compromised git remote fails
  the check), applies the tag, health-gates the node, and rolls back
  automatically on failure.
- `run-node/install-node.sh` — a fresh node checks out the latest anchored
  release tag, never a moving branch.

The chain is the source of truth; any git hosting is a mirror.
