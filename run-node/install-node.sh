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
[ "$RAM_MB" -ge 2500 ] || echo "WARN: ${RAM_MB}MB RAM — enough for a plain node (~2GB), NOT for an LP box (needs 4GB+, use install-lp.sh on a bigger machine)"

echo "[1/7] dependencies"
apt-get update -qq
apt-get install -y -qq curl git python3 build-essential >/dev/null
if ! command -v node >/dev/null || [ "$(node -e 'console.log(parseInt(process.versions.node))')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "[2/7] download + verify binary (SHA256 pinned in this script and published in the release checksums)"
cd /tmp
curl -fsSL -o "$TAR" "${BASE}/${TAR}"
echo "${TAR_SHA}  ${TAR}" | sha256sum -c -
tar -xzf "$TAR"
install -m 0755 goldbrix-*/bin/goldbrixd goldbrix-*/bin/goldbrix-cli /usr/local/bin/
ln -sf /usr/local/bin/goldbrixd /usr/local/bin/goldbrix-node
[ -e /usr/local/bin/goldbrix-cli ] || true

echo "[3/7] node config (full, txindex — required to serve wallet reads)"
id -u gbx &>/dev/null || useradd -r -m -d "$DATADIR" -s /usr/sbin/nologin gbx
mkdir -p "$DATADIR"
NEED_REINDEX=0
if [ -f "$DATADIR/goldbrix.conf" ]; then
  # A node that was already running here may be configured in a way that cannot
  # serve wallet reads. Those settings are corrected in place; everything else
  # the operator wrote is kept.
  cp "$DATADIR/goldbrix.conf" "$DATADIR/goldbrix.conf.bak.$(date -u +%Y%m%d%H%M%S)"
  grep -qE '^prune=0$' "$DATADIR/goldbrix.conf" || NEED_REINDEX=1
  grep -qE '^txindex=1$' "$DATADIR/goldbrix.conf" || NEED_REINDEX=1
  for kv in server=1 txindex=1 prune=0 listen=1; do
    k="${kv%%=*}"
    if grep -qE "^${k}=" "$DATADIR/goldbrix.conf"; then
      sed -i "s#^${k}=.*#${kv}#" "$DATADIR/goldbrix.conf"
    else
      echo "$kv" >> "$DATADIR/goldbrix.conf"
    fi
  done
  if [ "$NEED_REINDEX" = "1" ]; then
    echo "NOTE: this machine was running a node that cannot serve wallet reads"
    echo "      (pruned, or without a transaction index). The settings are now"
    echo "      corrected and the chain will be rebuilt once, from the start."
    echo "      This takes hours and needs no supervision; the node stays offline"
    echo "      to wallets until it finishes, and publishes itself only when ready."
    touch "$DATADIR/.needs-reindex"
  fi
else
  cat > "$DATADIR/goldbrix.conf" << 'CONF'
server=1
txindex=1
prune=0
listen=1
dbcache=1024
fallbackfee=0.0001
CONF
fi
mkdir -p "$DATADIR/index"

# Peer bootstrap from the federation, not from a fixed host.
# The node registry lives on chain (GBX:NODE). Any node that answers can hand
# over the peers it already gossips over P2P, so this install does not depend on
# a DNS seed, on the seeds baked into the binary, or on any single operator.
# Silent by design: if nothing answers, the baked-in seeds still apply.
if ! grep -q '^addnode=' "$DATADIR/goldbrix.conf" 2>/dev/null; then
  echo "[3b/7] peer bootstrap via on-chain node registry"
  # Bootstrap entries ship with this script: on a clean machine the tools repo is
  # only cloned in step 4, so a file-based list is empty exactly when it is needed.
  # These are entry points for the FIRST question only - the answer comes from the
  # on-chain registry below, and any live node can replace them.
  ENTRY="https://155-117-232-248.sslip.io/api https://goldbrix.app/api"
  BOOT_SRC="$TOOLSDIR/nodes.json"
  if [ -f "$BOOT_SRC" ]; then
    EXTRA=$(python3 -c "import json,sys;print(' '.join(json.load(open('$BOOT_SRC')).get('nodes',[])))" 2>/dev/null || true)
    [ -n "$EXTRA" ] && ENTRY="$EXTRA $ENTRY"
  fi
  REG=""
  for u in $ENTRY; do
    REG=$(curl -fsSL -m 12 "$u/node-registry" 2>/dev/null) && [ -n "$REG" ] && break
  done
  NODES=""
  if [ -n "$REG" ]; then
    NODES=$(printf '%s' "$REG" | python3 -c "import json,sys;print(' '.join(json.load(sys.stdin).get('nodes',{}).keys()))" 2>/dev/null || true)
  fi
  ALL="$NODES $ENTRY"
  PEERS=""
  for u in $ALL; do
    P=$(curl -fsSL -m 15 "$u/peers" 2>/dev/null) || continue
    PEERS=$(printf '%s' "$P" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
rows=[x for x in d.get('peers',[]) if x.get('address') and x.get('port')]
rows.sort(key=lambda x:(not x.get('full'), -(x.get('last_seen') or 0)))
print('\n'.join('addnode='+x['address']+':'+str(x['port']) for x in rows[:12]))
" 2>/dev/null || true)
    [ -n "$PEERS" ] && break
  done
  if [ -n "$PEERS" ]; then
    printf '%s\n' "$PEERS" >> "$DATADIR/goldbrix.conf"
    echo "PEERS: $(printf '%s\n' "$PEERS" | grep -c '^addnode=') learned from the on-chain federation"
  else
    echo "PEERS: federation unreachable - falling back to the seeds baked in the binary"
  fi
fi

chown -R gbx:gbx "$DATADIR"

echo "[4/7] read-api + indexer from goldbrix-tools"
[ -d "$TOOLSDIR/.git" ] && git -C "$TOOLSDIR" pull -q || git clone -q "$TOOLS_REPO" "$TOOLSDIR"
cd "$TOOLSDIR/read-api"
npm install --omit=dev --silent better-sqlite3

echo "[5/7] systemd units"
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
# A chain that was pruned, or indexed without txindex, cannot answer wallet
# reads. It is rebuilt once: the marker below is written by the installer and
# removed by the first rebuild, so a restart never triggers it again.
ExecStartPre=/bin/sh -c 'if [ -f ${DATADIR}/.needs-reindex ]; then /usr/local/bin/goldbrixd -datadir=${DATADIR} -conf=goldbrix.conf -reindex -daemon=0 && rm -f ${DATADIR}/.needs-reindex; fi; exit 0'
ExecStart=/usr/local/bin/goldbrixd -datadir=${DATADIR} -conf=goldbrix.conf
Restart=always
RestartSec=10
# Rebuilding the chain runs inside ExecStartPre and takes hours on a slow disk.
# The default start timeout would kill it and restart it forever.
TimeoutStartSec=infinity
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
# Answers only to the proxy on this machine. The public door is HTTPS.
Environment=GBX_CLI=/usr/local/bin/goldbrix-cli GBX_RPC_PORT=8332 GBX_DATADIR=${DATADIR} PORT=8088 GBX_BIND=127.0.0.1
Environment=GBX_NODEREG_STATE=${TOOLSDIR}/node-registry/node-registry.json
# read-api MUST read the local index; without it, address/utxo routes fall back to a full UTXO scan (2.5G RSS -> OOM).
Environment=GBX_INDEX_DB=${DATADIR}/index/gbx-index.db
# Without this the coin endpoints answer "not enabled", even while the index runs.
Environment=GBX_TOKENIDX_DB=${DATADIR}/index/curve-mainnet.db
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

# Coins and their bonding curves are read from this index. Without it a node
# answers "not enabled" on /api/curves, cannot pass its own health check, and so
# never publishes itself: a node that ships the wallet must also serve the coins.
cat > /etc/systemd/system/gbx-curve-index.service << UNIT
[Unit]
Description=GBX curve index scanner (consensus mirror)
After=goldbrixd.service
PartOf=goldbrixd.service
[Service]
User=gbx
Group=gbx
WorkingDirectory=${TOOLSDIR}/token-index
Environment=GBX_BIN=/usr/local/bin/goldbrix-cli
Environment=GBX_DATADIR=${DATADIR}
Environment=GBX_CHAIN=main
Environment=GBX_RPC_PORT=8332
Environment=GBX_TOKENIDX_DB=${DATADIR}/index/curve-mainnet.db
Environment=GBX_SQLITE_MOD=${TOOLSDIR}/read-api/node_modules/better-sqlite3
Environment=GBX_LAUNCHPAD_HEIGHT=2720000
Environment=MALLOC_ARENA_MAX=2
ExecStart=/usr/bin/node ${TOOLSDIR}/token-index/scanner.js --loop
Restart=on-failure
RestartSec=10
MemoryMax=1024M
[Install]
WantedBy=multi-user.target
UNIT

install -d -o gbx -g gbx ${DATADIR}/index
systemctl enable --now goldbrixd gbx-read-api gbx-indexer gbx-node-registry gbx-curve-index

echo "[6/7] web server (Caddy) — this node also serves the wallet"
# A node that only serves data still leaves the wallet itself hosted somewhere else.
# Serving client/ here is what makes a third-party node self-sufficient.
NODE_ENV_EARLY="${TOOLSDIR}/run-node/node.env"
PUB=$(grep -E '^NODE_PUBLIC_URL=' "$NODE_ENV_EARLY" 2>/dev/null | cut -d= -f2- || true)
# First run has no node.env yet, so the address given on the command line counts.
[ -n "${PUB:-}" ] || PUB="${NODE_PUBLIC_URL:-}"
HOSTN=$(printf '%s' "${PUB:-}" | sed -e 's#^https\?://##' -e 's#/.*$##')
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq caddy >/dev/null 2>&1 || true
fi
if ! command -v caddy >/dev/null 2>&1; then
  echo "WARN: caddy not available from this distribution. Node works locally on :8088;"
  echo "      serve ${TOOLSDIR}/client and proxy /api yourself (see docs/RUN-NODE-CADDY.md)."
else
  LPBLOCK=""
  if ss -ltn 2>/dev/null | grep -q ':18099'; then
    LPBLOCK=$'\n\thandle_path /lp/* {\n\t\treverse_proxy 127.0.0.1:18099\n\t}'
  fi
  SITE="${HOSTN:-:80}"
  CADDYCONF=$(printf '%s' "# managed by install-node.sh — remove this line to keep your own config
${SITE} {
\theader {
\t\tX-Content-Type-Options \"nosniff\"
\t\t-Server
\t}
\theader /api/* Access-Control-Allow-Origin \"*\"
\theader /api/* Cache-Control \"no-store\"${LPBLOCK}
\thandle /api/* {
\t\treverse_proxy 127.0.0.1:8088 {
\t\t\theader_down -Access-Control-Allow-Origin
\t\t}
\t}
\t@code path *.js *.mjs *.css *.html
\theader @code Cache-Control \"no-cache\"
\thandle {
\t\troot * ${TOOLSDIR}/client
\t\ttry_files {path} {path}.html /index.html
\t\tfile_server
\t}
}")
  printf '%b\n' "$CADDYCONF" > "${TOOLSDIR}/run-node/Caddyfile.example"
  if [ ! -f /etc/caddy/Caddyfile ] || grep -q 'managed by install-node.sh' /etc/caddy/Caddyfile; then
    install -d /etc/caddy
    printf '%b\n' "$CADDYCONF" > /etc/caddy/Caddyfile
    caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
      && { systemctl enable --now caddy >/dev/null 2>&1; systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy >/dev/null 2>&1; \
           echo "WEB: serving ${TOOLSDIR}/client on ${SITE}"; } \
      || echo "WARN: generated Caddyfile did not validate — left in place, check: caddy validate --config /etc/caddy/Caddyfile"
  else
    echo "WEB: /etc/caddy/Caddyfile is yours — not touched."
    echo "     Model written to ${TOOLSDIR}/run-node/Caddyfile.example (serves client/ and proxies /api)."
  fi
  if [ -z "$HOSTN" ]; then
    echo "WEB: no NODE_PUBLIC_URL set — serving over plain HTTP on :80 only."
    echo "     Wallets are loaded over HTTPS; set NODE_PUBLIC_URL in run-node/node.env and re-run for automatic TLS."
  fi
fi

# federation announce — ON by default, like a node that listens for peers.
# A node that answers wallet reads is only useful if wallets can find it. The
# entry lives on-chain and costs a dust fee, so it needs a wallet on THIS machine,
# whose key never leaves it. A fresh machine has no coins yet: the timer keeps
# trying and the node lists itself the moment the wallet is funded. Nobody has to
# come back and finish the job. Set ANNOUNCE=no to stay unlisted.
NODE_ENV="${TOOLSDIR}/run-node/node.env"
[ -f "$NODE_ENV" ] || cat > "$NODE_ENV" <<NENV
# Public HTTPS endpoint of this node. Wallets reach it here.
NODE_PUBLIC_URL=${NODE_PUBLIC_URL:-}
# Announce this node on-chain so wallets can find it. Set to no to stay unlisted.
ANNOUNCE=yes
# Wallet on this machine that pays the dust fee. Its key never leaves this machine.
ANNOUNCE_WALLET=gbx_node
NENV
NODE_URL=$(grep -E '^NODE_PUBLIC_URL=' "$NODE_ENV" | cut -d= -f2-)
[ -n "$NODE_URL" ] || NODE_URL="${NODE_PUBLIC_URL:-}"
ANN=$(grep -E '^ANNOUNCE=' "$NODE_ENV" | cut -d= -f2-)
AWALLET=$(grep -E '^ANNOUNCE_WALLET=' "$NODE_ENV" | cut -d= -f2-)
[ -n "$AWALLET" ] || AWALLET=gbx_node

if [ "${ANN:-yes}" = "no" ]; then
  echo "ANNOUNCE: disabled in node.env — this node stays unlisted."
elif [ -z "$NODE_URL" ]; then
  echo "ANNOUNCE: no public address for this node, so wallets cannot be sent here."
  echo "          Set NODE_PUBLIC_URL in ${NODE_ENV} and re-run to join the federation."
else
  NREG=${TOOLSDIR}/node-registry
  CLI_A="goldbrix-cli -datadir=${DATADIR} -conf=goldbrix.conf"
  $CLI_A loadwallet "$AWALLET" >/dev/null 2>&1 \
    || $CLI_A createwallet "$AWALLET" >/dev/null 2>&1 || true
  AADDR=$($CLI_A -rpcwallet="$AWALLET" getnewaddress "node-announce" 2>/dev/null || echo "")
  ABAL=$($CLI_A -rpcwallet="$AWALLET" getbalance 2>/dev/null || echo 0)

  python3 - "$NREG/announce.json" "$NODE_URL" "$AWALLET" <<'PYJSON'
import json,os,sys
f,node,w=sys.argv[1],sys.argv[2],sys.argv[3]
cfg=json.load(open(f)) if os.path.exists(f) else {}
cfg["node"]=node; cfg["wallet"]=w
json.dump(cfg,open(f,"w"),indent=2)
PYJSON
  cp $NREG/gbx-announce.service /etc/systemd/system/
  cp $NREG/gbx-announce.timer   /etc/systemd/system/
  install -d /etc/systemd/system/gbx-announce.service.d
  printf '[Service]\nEnvironment=GBX_DATADIR=%s\n' "$DATADIR" > /etc/systemd/system/gbx-announce.service.d/datadir.conf
  systemctl daemon-reload && systemctl enable --now gbx-announce.timer
  GBX_DATADIR=$DATADIR bash $NREG/gbx-announce.sh || true
  echo "ANNOUNCE: enabled. This node lists itself at ${NODE_URL} and keeps the entry"
  echo "          alive on its own, for as long as it runs."
  if python3 -c "import sys;sys.exit(0 if float('${ABAL:-0}')>0 else 1)" 2>/dev/null; then
    echo "          Fee wallet is funded — the entry goes on-chain now."
  else
    echo "          The fee wallet is empty, so the entry is not on-chain yet."
    echo "          Send a few brix to:  ${AADDR}"
    echo "          The node publishes itself on its own once the coins arrive;"
    echo "          nothing else has to be done here."
  fi
fi

echo "[7/7] done"
echo "Sync from genesis starts now (peers learned from the on-chain federation, plus the seeds baked in the binary — no central server, no DNS seed required)."
echo "Check:   goldbrix-cli -datadir=${DATADIR} getblockchaininfo | grep -e blocks -e verificationprogress"
echo "Status:  curl -s http://127.0.0.1:8088/api/status"
echo "When fully synced: expose :8088 behind HTTPS (Caddy/nginx)."
echo "Discovery is 100% on-chain (GBX:NODE) — no central list, no app rebuild, nothing to register with anyone."
