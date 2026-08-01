# GBX HTLC on Solana

The program that holds USDC during a swap, at
`AAbKiRpmY5jYfC37DuQ9aTsWnNqxZXLe4fvyGSb3YS1F` on Solana mainnet.

It does three things: `lock` puts USDC in a vault behind a hashlock and a
timelock, `claim` releases it to the receiver against the preimage, `refund`
returns it to the sender once the timelock passes. Whoever pays the network fee
is not who gets the money: `refund` requires the destination token account to
belong to the original sender, and `claim` requires the preimage. That is what
makes a swap safe to enter without trusting the other side.

## Check that this source is what runs on the chain

Nothing here has to be taken on faith. Pull the deployed bytes and compare:

    solana program dump AAbKiRpmY5jYfC37DuQ9aTsWnNqxZXLe4fvyGSb3YS1F onchain.so \
      --url https://api.mainnet-beta.solana.com
    sha256sum onchain.so

The deployed account is padded with trailing zero bytes; strip them before
hashing to get the program itself:

    python3 -c "import hashlib;d=open('onchain.so','rb').read().rstrip(b'\x00');print(len(d),hashlib.sha256(d).hexdigest())"

    232225  6665e99c5f85decd6373b83fa1e0273079d6df4f25b4a52fa8a5b80ef42532d6

Padded account as returned by `solana program dump`, 232240 bytes:

    8691de77994be20503cd9fd861ccbc457764abc2a3a81f1acecc4ac6dfefb605

## Build

    anchor build

Rust 1.89.0, Anchor 1.1.2, as pinned in the manifests.
