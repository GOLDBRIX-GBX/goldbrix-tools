# Release Anchors (on-chain)

Every GoldBrix release is anchored on-chain. The SHA-256 of the release's
`SHA256SUMS` file is published in an OP_RETURN output. GitHub or the website
can disappear — the canonical hash lives in the chain itself.

## Format

```
GBX:R:<tag>:<sha256-hex>
```

- `<tag>` — release tag (e.g. `v30-gbx-7`)
- `<sha256-hex>` — SHA-256 of the `SHA256SUMS-<tag>.txt` release asset (64 hex chars)
- Total: 80 bytes, standard OP_RETURN

> Note: OP_RETURN budget is 80B, so tags >9 chars are anchored short-form (e.g. `v30-gbx-10` → `gbx-10`). The full tag is always in the `SHA256SUMS-<full-tag>.txt` asset.

## Anchors

| Tag | SHA-256 of SHA256SUMS | TX |
|-----|----------------------|-----|
| v30-gbx-7 | 00cf8408f0c1fb728ae38d701c73e30fc2b04cf66487e102a8f6011e35a542c4 | 738d7434a4e46cfc67c8f4c47ff55aaa596ef592f99409c23c8e3b446df419f6 |
| v30-gbx-10 (anchored as `gbx-10`) | 278586e1571861d4f2f4c38fb9cd05fe8213d432084fcb571021db7568e527e4 | 72374fa90764de31295bad482ae335d6a5e9b3099872556cd199afbedd95dfc2 |
| v31-gbx-launchpad (anchored as `v31`) | 40cee217f050e759e5b8d35283302d474b23095b6ec702473af73801b9664315 | 0b8cfced03ee2db2a60d4d0c16c1e85bc5f5a87a329b123cbd7a1f52f5d66893 |
| v31-gbx-federation (anchored as `v31f`) | 78ea0bbcfe960c5245986f3c7eba0133c26954869b0b3c325ed26c23e23f804e | ba26367636fc7b00c70a391c3664aa5171ff04438b1b935a93db52e271d236a0 |
| v31-gbx-launchpad, APK 1.0.116 (anchored as `v31a`) | 4ddb0dc8dc5e05b0a53d13ed2f6f18127be336e8d84fb64acb0b3faeea7b124f | 4d6935eff835c970b7f125548c73289668b0841b07f454178073a9e84e75f1cd |
| v31-gbx-launchpad, APK 1.0.117 (anchored as `v31b`) | 311998e8b1f55d84b365444c0eed698491a7e9edd05dcb5911aefe34f20a2bf4 | 60043e70f9090142fceddee447689ed6c7bfcbb2c7cfe2fcbda75e400af41923 |
| v31-gbx-launchpad, APK 1.0.118 (anchored as `v31c`) | 10e544b2ceac6fa542a307fe884f3ae007d2777636b5da60e7f7d2f3ec01ef1e | 915957343b396a40b6e0edc9f312c75f104eb9bc33eb3720ab6ea0b6f951f715 |

## Verify (any node, no permission needed)

```bash
# 1. decode the anchor from the chain
goldbrix-cli getrawtransaction <txid> 1 \
  | grep -o '"asm": "OP_RETURN [0-9a-f]*"' \
  | grep -o '[0-9a-f]\{20,\}' | xxd -r -p; echo

# 2. hash the SHA256SUMS you downloaded (GitHub Releases or any mirror)
sha256sum SHA256SUMS-v30-gbx-7.txt

# 3. the two hashes must match. Then verify each asset:
sha256sum -c SHA256SUMS-v30-gbx-7.txt
```

If step 3 matches, your binary/APK is exactly what was anchored on-chain,
regardless of where you downloaded it from.

## What an anchor proves — and what it does not

An anchor proves **integrity**: the bytes you hold are the bytes that were
anchored. It does not and cannot prove **authority**: an OP_RETURN can be
written by anyone with a few base units, so after the founder's departure
there may one day be several anchors carrying the same tag and different
hashes. No user should have to guess which one is "official" — and by
design, none is.

There is no release authority in GoldBrix, and none will ever be created.
No key, no account and no person — including the founder — can designate
a build as the true one. What replaces authority:

- **Reproducible builds.** The source is public; anyone can build it and
  compare their own hash against an anchor. Trust the math, not the
  publisher.
- **Your node, your rules.** A patch that changes consensus is not an
  update — it is a different chain. Every operator decides for themselves
  what code they run.
- **Adoption is the only signal.** A release "wins" only by independent
  operators choosing to run it. Nothing else confers legitimacy.

If you ever face two conflicting anchors: build from source, verify, and
decide like an operator. That is not a weakness of the system — it is the
system.

