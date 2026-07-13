# GoldBrix miner-box

One-command setup for a miner: payout wallet + automatic daily UTXO consolidation.
Non-custodial: keys live only in your own node wallet; nothing phones home.

## Install

    ./install-miner.sh new       # generate a wallet on this node (back it up!)
    ./install-miner.sh import    # import your 12/24-word phrase (e.g. from the GoldBrix app)

Optional miner unit in the same run:

    GBX_CPUMINER=/root/cpuminer/minerd ./install-miner.sh import

## What it does

1. Pre-flight: node reachable, tools present, fee config checked.
2. Wallet: creates `miner_wallet` (or imports your phrase; address shown for visual confirmation before anything else happens).
3. Installs `gbx-consolidate` service + daily timer: when mature coinbase UTXOs exceed the threshold (default 200), they are merged into a single output to your own address. Keeps your wallet fast and the global UTXO set small.
4. Optional: installs the miner unit pointed at your address.
5. Self-test.

## Tunables (env)

GBX_DATADIR, GBX_WALLET, GBX_THRESHOLD (200), GBX_MAX_INPUTS (500),
GBX_MINCONF (100), GBX_FEERATE_SATVB (1), GBX_POOL, GBX_WORKER.

Safety: destination must be `ismine`; only mature (>=100 conf) coinbase-class
UTXOs are touched; explicit fee, no fee estimation dependency; fail-loud everywhere.
