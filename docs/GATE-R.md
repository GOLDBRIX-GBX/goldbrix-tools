# Gate R — the founder's exit, executed on-chain

On 25 August 2026 the founder permanently gave up every form of control
over the GoldBrix network. This document lists each step and how anyone
can verify it independently. Nothing below relies on trusting this
repository: every claim resolves to a chain, a public blockchain, or a
permanent archive.

## 1. The Solana HTLC program is immutable

The cross-chain swap program on Solana mainnet can never be upgraded
again, by anyone:

    solana program show AAbKiRpmY5jYfC37DuQ9aTsWnNqxZXLe4fvyGSb3YS1F \
      --url https://api.mainnet-beta.solana.com

Expected output: `Authority: none`.

The HTLC contracts on Base
(`0x8e351c32dfb27aa22334a20dcf7272f54f78e0c0`) and Arbitrum
(`0xa43813d90adb98a5c400113ce2cc29d43d4ab867`) never had an owner
function to begin with.

## 2. The treasury and every founder wallet were burned

All GBX held by founder-controlled wallets was sent to the provably
unspendable burn address `bn1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3kc3g2`:

| Wallet | Amount (GBX) | Transaction |
|---|---|---|
| treasury | ~469,910.85 | `0cce2e8e1868c86ed8eca8017e97c25f0a8220ac44daefa5d580c36648b47b48` |
| founder LP | ~27.98 | `20d8a7650a191231ead4ce9e0e068fa141febd74158679cd6cce5db170a249e6` |
| announce | ~0.999 | `b41b927b8420d025f61c3ddd40c71d62e87b4cd35cabecb83f6b3f14b3ac622a` |

Verify in any explorer (`/v3/explorer.html` on any federation node), or
query `/api/burns` on any node for the network-wide burn total.

## 3. The keys were destroyed

- The **announce key** — the only key that could ever anchor a release
  (`GBX:R`, `GBX:ARW`) — was destroyed after its balance was burned
  (third transaction above). The release lineage, which walks back
  through `vin[0]` to the root coinbase
  `6aef6c971eac85c50990de354f5bb8386ff264ae09616c74c7a3949e66950400`,
  is now mathematically frozen. No future release can ever be anchored,
  by anyone, including the founder.
- The **Arweave wallet key** was destroyed. The permanent archives can
  never be extended or replaced; the remaining wallet balance is
  abandoned by design.

## 4. The canonical source is permanent

The final source code lives on Arweave, anchored on the GBX chain:

| Archive | Arweave TX | SHA-256 | Commit | GBX anchor |
|---|---|---|---|---|
| tools-final | `nVkgMqVScD8iq5e5RyxxCzImsREJkKCR7Qs-VSj2kOc` | `368814f002bb0b21e8d78072dd3756323b0ade43b06c0a6a6c531ec0b3f6585a` | `9216416c` | `8c78370466a4fb5c836fa1817fd516b65533fdf185fad0428fa0a7f161d87c36` |
| core-final | `xsVFhwVAkHyZwc7zT2X4Ml_Qhx8c9EofAk3tbizAhmc` | `bd5cdf3eed5c7ca314d19c22b2a5a50cbe8c6957ef255b44b822c3e6a330c5a2` | `8f970aa4` | `d8d800db9bd7834728b580ca1384c40c9d34144475ec21ebd44391978aef534b` |

Download either archive from `https://arweave.net/<TX>`, hash it, and
compare. Details: [ARWEAVE.md](ARWEAVE.md) ·
[RELEASE-ANCHOR.md](RELEASE-ANCHOR.md).

This GitHub organization is a convenience mirror. Any commit made after
the anchors above cannot be anchored on-chain and is therefore outside
the verified lineage — the archives are the source of truth.

## 5. What remains

Nothing that requires the founder. The chain is mined by whoever mines
it. Nodes, LPs and HTLC endpoints announce themselves on-chain and the
client discovers them from the chain. The consensus binary
(`v31-gbx-federation`, core commit `8f970aa4`) is frozen and
reproducible with Guix. There is no owner. That was the point.
