#!/usr/bin/env bash
# GoldBrix (GBX) — one-command third-party full node + public read endpoint
# Installs: goldbrixd (full, non-pruned, txindex) + read-api (:8088) + address indexer
# Keyless: this machine never holds funds. It reads the chain and relays raw transactions.
# Usage: sudo bash install-node.sh
set -euo pipefail

REL="v31-gbx-launchpad"
TAR="goldbrix-1747c8e2d817-x86_64-linux-gnu.tar.gz"
TAR_SHA="bdbac8ac96e7ce62bc060ba908667cd276abc5ca53c85591d8c3253e4f14258e"
BASE="https://github.com/GOLDBRIX-GBX/goldbrix-core/releases/download/${REL}"
TOOLS_REPO="https://github.com/GOLDBRIX-GBX/goldbrix-tools.git"
DATADIR="/var/lib/goldbrix"
TOOLSDIR="/opt/goldbrix-tools"

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] || { echo "x86_64 only (got $ARCH)"; exit 1; }
FREE_GB=$(df --output=avail -BG "$(dirname "$DATADIR")" | tail -1 | tr -dc '0-9')
[ "$FREE_GB" -ge 40 ] || { echo "need >=40GB free (chain ~6GB now, grows over time), have ${FREE_GB}GB"; exit 1; }
RAM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
[ "$RAM_MB" -ge 1800 ] || { echo "FAIL: ${RAM_MB}MB RAM < 2GB — a plain node needs ~2GB (measured: idle node ~1.1GB). Upgrade RAM first."; exit 1; }
[ "$RAM_MB" -ge 2500 ] || echo "WARN: ${RAM_MB}MB RAM — enough for a plain node (~2GB), NOT for an LP box (needs 8GB, use install-lp.sh on a bigger machine)"

echo "[1/6] dependencies"
apt-get update -qq
apt-get install -y -qq curl git python3 build-essential >/dev/null
if ! command -v node >/dev/null || [ "$(node -e 'console.log(parseInt(process.versions.node))')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "[2/6] download + verify binary (SHA256 pinned in this script AND on-chain anchor tx 738d7434…)"
cd /tmp
curl -fsSL -o "$TAR" "${BASE}/${TAR}"
echo "${TAR_SHA}  ${TAR}" | sha256sum -c -
tar -xzf "$TAR"
install -m 0755 goldbrix-*/bin/goldbrixd goldbrix-*/bin/goldbrix-cli /usr/local/bin/
ln -sf /usr/local/bin/goldbrixd /usr/local/bin/goldbrix-node
[ -e /usr/local/bin/goldbrix-cli ] || true

echo "[3/6] node config (full, txindex — required to serve wallet reads)"
id -u gbx &>/dev/null || useradd -r -m -d "$DATADIR" -s /usr/sbin/nologin gbx
mkdir -p "$DATADIR"
[ -f "$DATADIR/goldbrix.conf" ] || cat > "$DATADIR/goldbrix.conf" << 'CONF'
server=1
txindex=1
prune=0
listen=1
dbcache=1024
fallbackfee=0.0001
CONF
mkdir -p "$DATADIR/index"
chown -R gbx:gbx "$DATADIR"

echo "[4/6] read-api + indexer from goldbrix-tools"
[ -d "$TOOLSDIR/.git" ] && git -C "$TOOLSDIR" pull -q || git clone -q "$TOOLS_REPO" "$TOOLSDIR"
cd "$TOOLSDIR/read-api"
npm install --omit=dev --silent better-sqlite3

echo "[5/6] systemd units"
cat > /etc/systemd/system/goldbrixd.service << UNIT
[Unit]
Description=GoldBrix Core full node
After=network-online.target
Wants=network-online.target
[Service]
User=gbx
# glibc arena fragmentation: 16 arenas balloon a long-running node's heap.
# Proven on a live node: 3.85 GB RSS -> 1.07 GB with 2 arenas, no perf loss.
Environment=MALLOC_ARENA_MAX=2
ExecStart=/usr/local/bin/goldbrixd -datadir=${DATADIR} -conf=goldbrix.conf
Restart=always
RestartSec=10
TimeoutStopSec=600
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/gbx-read-api.service << UNIT
[Unit]
Description=GBX public read API (:8088, keyless)
After=goldbrixd.service
Requires=goldbrixd.service
[Service]
User=gbx
Environment=GBX_CLI=/usr/local/bin/goldbrix-cli GBX_RPC_PORT=8332 GBX_DATADIR=${DATADIR} PORT=8088
Environment=GBX_NODEREG_STATE=${TOOLSDIR}/node-registry/node-registry.json
# RA-1 (s38): read-api MUST read the local index; without it, address/utxo routes fall back to a full UTXO scan (2.5G RSS -> OOM).
Environment=GBX_INDEX_DB=${DATADIR}/index/gbx-index.db
WorkingDirectory=${TOOLSDIR}/read-api
ExecStart=/usr/bin/node read-api.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/gbx-indexer.service << UNIT
[Unit]
Description=GBX address indexer (local SQLite, no third party)
After=goldbrixd.service
Requires=goldbrixd.service
[Service]
User=gbx
Environment=GBX_CLI=/usr/local/bin/goldbrix-cli GBX_RPC_PORT=8332 GBX_DATADIR=${DATADIR} GBX_INDEX_DB=${DATADIR}/index/gbx-index.db
WorkingDirectory=${TOOLSDIR}/read-api
ExecStart=/usr/bin/node gbx-indexer.js
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
cat > /etc/systemd/system/gbx-node-registry.service << UNIT
[Unit]
Description=GBX Node Registry Scanner (on-chain GBX:NODE discovery)
After=goldbrixd.service
Requires=goldbrixd.service
[Service]
Environment=GBX_DATADIR=${DATADIR}
Environment=GBX_NODEREG_STATE=${TOOLSDIR}/node-registry/node-registry.json
WorkingDirectory=${TOOLSDIR}/node-registry
ExecStart=/usr/bin/node scanner.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

systemctl enable --now goldbrixd gbx-read-api gbx-indexer gbx-node-registry

echo "[6/6] done"
echo "Sync from genesis starts now (headers via fixed seeds baked in the binary — no central server needed)."
echo "Check:   goldbrix-cli -datadir=${DATADIR} getblockchaininfo | grep -e blocks -e verificationprogress"
echo "Status:  curl -s http://127.0.0.1:8088/api/status"
echo "When fully synced: expose :8088 behind HTTPS (Caddy/nginx), then submit your endpoint"
echo "for inclusion in https://goldbrix.app/nodes.json — wallets add you via quorum, no app rebuild."
