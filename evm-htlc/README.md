# GBX HTLC on Base and Arbitrum

The contract that holds USDC during a swap:

- Base (chain 8453): `0x8e351c32dfb27aa22334a20dcf7262f54f78e0c0`
- Arbitrum (chain 42161): `0xa43813d90adb98a5c400113ce2cc29d43d4ab867`

Same source on both. It locks USDC behind a hashlock and a timelock, releases it
to the receiver against the preimage, and returns it to the sender once the
timelock passes. The hashlock is SHA-256, the same one the GBX side uses, so a
single preimage settles both legs of a swap.

There is no owner, no admin, no upgrade path and no selfdestruct. Nobody can
change the code or redirect the funds, including whoever deployed it. That is
checkable in one call: `owner()` reverts, because the function does not exist.

    cast call 0x8e351c32dfb27aa22334a20dcf7262f54f78e0c0 "owner()" --rpc-url https://mainnet.base.org

## Check that this source is what runs on the chain

    forge build
    cast code 0x8e351c32dfb27aa22334a20dcf7262f54f78e0c0 --rpc-url https://mainnet.base.org

Two things differ from a plain byte comparison, both expected:

The last bytes of any Solidity output are a metadata block, whose length is
written in the final two bytes. Strip it from both sides before comparing.

Bytes 1394-1425 and 1702-1733 of the runtime hold the EIP-712 domain separator,
which is computed at deploy time from the chain id and the contract's own
address. It differs between the two chains for that reason, and cannot match a
local build either. Verify it directly instead:

    cast call 0x8e351c32dfb27aa22334a20dcf7262f54f78e0c0 "DOMAIN_SEPARATOR()" --rpc-url https://mainnet.base.org

Everything outside those two windows is identical across Base, Arbitrum and a
local build of this source:

    sha256 24fecfe4e5baf3b9f0bfd52f5b31430aef4a192f7072d1c70a769c7895ce4b1f

## Build

    forge build

solc 0.8.24, optimizer on with 200 runs, via-IR enabled, as pinned in foundry.toml.
