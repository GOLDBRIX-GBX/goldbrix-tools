#!/usr/bin/env bash
# GBX apply-release — deliberate operator action. Verifies the on-chain anchored
# release, checks the git tag against the CHAIN (not against GitHub's word),
# applies it, health-gates, and rolls back automatically on failure.
# Usage: bash apply-release.sh <tools-tag>   (e.g. tools-v2)
set -u
TAG="${1:-}"
TOOLSDIR="${GBX_TOOLSDIR:-/opt/goldbrix-tools}"
STATE="${GBX_RELCHK_STATE:-$TOOLSDIR/release-check/release-check.json}"
HEALTH_URL="${GBX_HEALTH_URL:-http://127.0.0.1:8088}"
die(){ echo "ABORT: $*" >&2; exit 1; }
[ -n "$TAG" ] || die "usage: bash apply-release.sh <tools-tag>"
[ -f "$STATE" ] || die "no verifier state ($STATE) - run gbx-release-check.service first"

# 1. The chain is the truth: the tag must be anchored AND lineage-valid.
read -r COMMIT VALID < <(python3 - "$STATE" "$TAG" <<'PYEOF'
import json,sys
st=json.load(open(sys.argv[1])); a=st.get("anchors",{}).get(sys.argv[2])
print((a or {}).get("commit",""),(a or {}).get("lineage_valid",False))
PYEOF
)
[ -n "$COMMIT" ] || die "tag $TAG not anchored on-chain (verifier state)"
[ "$VALID" = "True" ] || die "tag $TAG anchored but lineage INVALID - refusing"
echo "anchored commit: $COMMIT"

# 2. Fetch tags; the tag's commit must equal the CHAIN's commit (compromised
#    remote => mismatch => die).
[ -d "$TOOLSDIR/.git" ] || die "$TOOLSDIR is not a git clone (production copy?) - set GBX_TOOLSDIR to the clone you update from"
git -C "$TOOLSDIR" fetch -q --tags origin || die "git fetch failed"
GOT=$(git -C "$TOOLSDIR" rev-parse "refs/tags/$TAG^{commit}" 2>/dev/null) || die "tag $TAG not in repo"
[ "$GOT" = "$COMMIT" ] || die "tag commit $GOT != anchored $COMMIT - remote compromised or wrong tag"

# 3. Backup point + apply.
PREV=$(git -C "$TOOLSDIR" rev-parse HEAD)
echo "current HEAD: $PREV -> applying $TAG"
git -C "$TOOLSDIR" -c advice.detachedHead=false checkout -q "refs/tags/$TAG" || die "checkout failed"

# 4. Restart node-side services that exist on this machine (only those present).
# Default names, plus any enabled unit whose ExecStart physically points at the
# code we just changed - that finds an operator's own prefixes too.
SVCS="${GBX_SVCS:-gbx-read-api gbx-node-registry gbx-trade-index gbx-curve-index gbx-node-info}"
DERIVED=$(systemctl list-units --type=service --state=loaded --no-legend --plain 2>/dev/null | awk '{print $1}' | sed 's/\.service$//' | while read -r U; do
  systemctl show -p ExecStart -p WorkingDirectory --value "$U" 2>/dev/null | grep -q -- "$TOOLSDIR" && echo "$U"
done)
RESTARTED=0
for S in $(printf '%s\n' $SVCS $DERIVED | sort -u); do
  systemctl is-enabled "$S" >/dev/null 2>&1 || continue
  systemctl restart "$S" && RESTARTED=$((RESTARTED+1)) && echo "restarted $S"
done
[ "$RESTARTED" -gt 0 ] || { echo "no service restarted - new code is on disk but not running"; \
  git -C "$TOOLSDIR" checkout -q "$PREV"; die "nothing to restart; rolled back to $PREV (set GBX_SVCS to your unit names)"; }
sleep 4

# 5. Health-gate: local API answers on core routes.
ok=1
for R in /api/status /api/curves; do
  C=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' "$HEALTH_URL$R")
  echo "health $R -> $C"; [ "$C" = "200" ] || ok=0
done
if [ "$ok" = "1" ]; then
  echo "OK: $TAG applied and healthy (HEAD $(git -C "$TOOLSDIR" rev-parse --short HEAD))"
  exit 0
fi

# 6. Rollback: the node must never stay dead after a failed update.
echo "HEALTH FAILED - rolling back to $PREV"
git -C "$TOOLSDIR" checkout -q "$PREV"
for S in $(printf '%s\n' $SVCS $DERIVED | sort -u); do systemctl is-enabled "$S" >/dev/null 2>&1 && systemctl restart "$S"; done
sleep 4
for R in /api/status /api/curves; do
  echo "post-rollback $R -> $(curl -s --max-time 8 -o /dev/null -w '%{http_code}' "$HEALTH_URL$R")"
done
die "release $TAG failed health-gate; rolled back to $PREV"
