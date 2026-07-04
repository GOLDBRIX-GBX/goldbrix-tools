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

## Anchors

| Tag | SHA-256 of SHA256SUMS | TX |
|-----|----------------------|-----|
| v30-gbx-7 | 00cf8408f0c1fb728ae38d701c73e30fc2b04cf66487e102a8f6011e35a542c4 | 738d7434a4e46cfc67c8f4c47ff55aaa596ef592f99409c23c8e3b446df419f6 |

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
