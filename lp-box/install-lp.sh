#!/bin/bash
# GoldBrix LP-in-a-box installer. Run as root on YOUR machine. Your keys never leave it.
set -e
D=/opt/gbx-lp
command -v node >/dev/null || { echo "FAIL: node >=18 required"; exit 1; }
command -v python3 >/dev/null || { echo "FAIL: python3 required"; exit 1; }
python3 -c "import cryptography, ecdsa" 2>/dev/null || { echo "FAIL: pip3 install cryptography ecdsa"; exit 1; }
[ -x /usr/local/bin/goldbrix-cli ] || { echo "FAIL: GBX node required first (run install-node.sh)"; exit 1; }

# pre-flight gates — honest refusal beats a broken install
NV=$(node -v | sed 's/^v//;s/\..*//'); [ "$NV" -ge 18 ] || { echo "FAIL: node >=18 required (found $(node -v))"; exit 1; }
RAM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
[ "$RAM_MB" -ge 6000 ] || { echo "FAIL: ${RAM_MB}MB RAM < 6GB — node + LP will OOM. Upgrade RAM first."; exit 1; }
[ "$RAM_MB" -ge 8000 ] || echo "WARN: ${RAM_MB}MB RAM < 8GB — will run, but tight; watchdog is mandatory (installed below)"
DISK_GB=$(df -BG --output=avail /opt | tail -1 | tr -dc '0-9')
[ "$DISK_GB" -ge 30 ] || { echo "FAIL: ${DISK_GB}GB free on /opt < 30GB"; exit 1; }

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
GBX_GBX_DATADIR=/var/lib/goldbrix
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

# watchdog — application-level health (catches "alive but stuck"), local-only
cp $D/lp-box/lp-watchdog.sh $D/lp-watchdog.sh && chmod +x $D/lp-watchdog.sh
cat > /etc/systemd/system/gbx-lp-watchdog.service <<UNIT
[Unit]
Description=GoldBrix LP application watchdog (oneshot)
[Service]
Type=oneshot
ExecStart=$D/lp-watchdog.sh
UNIT
cat > /etc/systemd/system/gbx-lp-watchdog.timer <<UNIT
[Unit]
Description=GoldBrix LP watchdog every 5 min
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload && systemctl enable --now gbx-lp-watchdog.timer

# self-test — verdict, not hope
sleep 3; OK=1
J(){ curl -s -m 10 "http://127.0.0.1:18099$1" | python3 -c "import json,sys;print(json.load(sys.stdin)['$2'])" 2>/dev/null; }
H=$(J /height height);                    [ -n "$H" ] || { echo "SELF-TEST RED: /height";  OK=0; }
P=$(J /lp-info lp_gbx_pubkey);            [ -n "$P" ] || { echo "SELF-TEST RED: /lp-info"; OK=0; }
B=$(J "/quote?side=buy&gbx=10" price_usd);  [ -n "$B" ] || { echo "SELF-TEST RED: quote BUY";  OK=0; }
S=$(J "/quote?side=sell&gbx=10" price_usd); [ -n "$S" ] || { echo "SELF-TEST RED: quote SELL"; OK=0; }
if [ "$OK" = 1 ]; then echo "SELF-TEST GREEN: LP live on :18099 (height=$H, price=$B)"
else echo "SELF-TEST RED — check $D/state/lp_daemon.log and $D/state/lp_gateway.log"; exit 3; fi
