# GoldBrix LP-in-a-box: single source of paths. Override any via env GBX_<KEY>.
import os
_D = {
 "ADDRS_F":   "/root/base_mainnet_addrs.json",
 "ENV_F":     "/root/goldbrix-onramp/.env",
 "STATE_F":   "/root/lp_state_main.json",
 "INTENTS_F": "/root/lp_intents_main.json",
 "CONFIG_F":  "/root/lp_config.json",
 "CHAINS_F":  "/root/chains.json",
 "GCLI_BIN":  "/usr/local/bin/goldbrix-cli",
 "GBX_DATADIR":"/root/.bitcoin",
 "GBX_WALLET":"liquidity_pool_hot",
 "EVM_CLI":   "/root/goldbrix-onramp/evm-htlc-cli.mjs",
 "SOL_CLI":   "/root/gbx-solana-htlc/htlc/sol-htlc-cli.mjs",
 "SOL_IDL":   "/root/gbx-solana-htlc/htlc/target/idl/htlc.json",
 "SELL_GUARD_F":"/root/goldbrix-onramp/sell_guard.json",
 "RESERVES_F":"/root/lp_reserves.json",
}
E = {k: os.environ.get("GBX_"+k, v) for k, v in _D.items()}
