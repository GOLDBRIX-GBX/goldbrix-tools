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
 "INDEX_DB":  "",
}
# LP-19: index DB auto-detect daca nu e dat prin GBX_INDEX_DB
def _autodb():
    import os as _o
    for c in ("/root/goldbrix-one/server/gbx-index.db",
              "/var/lib/goldbrix/index/gbx-index.db",
              "/opt/goldbrix-tools/read-api/gbx-index.db"):
        if _o.path.exists(c): return c
    return ""
E = {k: os.environ.get("GBX_"+k, v) for k, v in _D.items()}
if not E.get("INDEX_DB"): E["INDEX_DB"] = _autodb()
