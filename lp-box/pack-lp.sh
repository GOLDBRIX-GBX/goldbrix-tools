#!/bin/bash
set -e
cd /root/goldbrix-onramp
OUT=/root/gbx-lp-box-$(date +%Y%m%d).tar.gz
tar czf $OUT \
  lp_daemon_main.py lp_gateway_main.py lp_solana.py lp_pricing.py _sol_key.py lp_env.py \
  evm-htlc-cli.mjs vendor/evm-secp.mjs vendor/evm-tx-core.mjs vendor/evm-htlc.mjs \
  lp-box/lp.env.template lp-box/chains.json.template lp-box/package.json lp-box/install-lp.sh \
  -C /root/gbx-solana-htlc/htlc sol-htlc-cli.mjs target/idl/htlc.json
echo "PACKED: $OUT"; tar tzf $OUT
