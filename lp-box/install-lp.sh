#!/bin/bash
# GoldBrix LP-in-a-box installer. Run as root on YOUR machine. Your keys never leave it.
set -e
D=/opt/gbx-lp
command -v node >/dev/null || { echo "FAIL: node >=18 required"; exit 1; }
command -v python3 >/dev/null || { echo "FAIL: python3 required"; exit 1; }
python3 -c "import cryptography, ecdsa" 2>/dev/null || { echo "FAIL: pip3 install cryptography ecdsa"; exit 1; }
[ -x /usr/local/bin/goldbrix-cli ] || { echo "FAIL: GBX node required first (run install-node.sh)"; exit 1; }

mkdir -p $D/keys $D/state $D/vendor $D/target/idl
tar xzf "$(dirname "$0")/../gbx-lp-box.tar.gz" -C $D 2>/dev/null || tar xzf gbx-lp-box.tar.gz -C $D
cd $D && cp lp-box/package.json . && npm install --omit=dev

[ -f $D/lp.env ] || cp $D/lp-box/lp.env.template $D/lp.env
[ -f $D/chains.json ] || cp $D/lp-box/chains.json.template $D/chains.json
grep -q CHANGE_ME $D/lp.env && { echo "EDIT $D/lp.env + $D/chains.json (FILL_YOUR_OWN), then re-run"; exit 2; }
grep -q FILL_YOUR_OWN $D/chains.json && { echo "EDIT $D/chains.json (FILL_YOUR_OWN), then re-run"; exit 2; }

# env overrides -> own paths, own state, own node
cat > $D/gbx-lp.env <<ENV
GBX_ENV_F=$D/lp.env
GBX_CHAINS_F=$D/chains.json
GBX_STATE_F=$D/state/lp_state.json
GBX_INTENTS_F=$D/state/lp_intents.json
GBX_CONFIG_F=$D/lp_config.json
GBX_EVM_CLI=$D/evm-htlc-cli.mjs
GBX_SOL_CLI=$D/sol-htlc-cli.mjs
GBX_SOL_IDL=$D/target/idl/htlc.json
GBX_SELL_GUARD_F=$D/state/sell_guard.json
GBX_RESERVES_F=$D/state/lp_reserves.json
GBX_GBX_DATADIR=/root/.bitcoin
GBX_GBX_WALLET=lp_hot
ENV

[ -f $D/lp_config.json ] || echo '{"price_usd": 0.1, "spread_bps": 50, "burn_bps": 0, "price_source": "reserve"}' > $D/lp_config.json

write_unit() {
cat > /etc/systemd/system/gbx-lp-$1.service <<UNIT
[Unit]
Description=GoldBrix LP-in-a-box ($1)
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=$D
EnvironmentFile=$D/gbx-lp.env
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 $D/$2
Restart=always
RestartSec=10
StandardOutput=append:$D/state/lp_$1.log
StandardError=append:$D/state/lp_$1.log
[Install]
WantedBy=multi-user.target
UNIT
}
write_unit daemon "lp_daemon_main.py 5 --loop"
write_unit gateway "lp_gateway_main.py 18099"
systemctl daemon-reload && systemctl enable --now gbx-lp-daemon gbx-lp-gateway
echo "OK: LP live on :18099"
