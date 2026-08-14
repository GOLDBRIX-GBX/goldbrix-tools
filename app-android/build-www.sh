#!/bin/bash
# GOLDBRIX — deterministic web bundle for the Android app.
# Builds android/app/src/main/assets/public from the versioned client/ directory.
# No webroot, no server, no network. Reproducible from a clean clone.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SRC="$REPO/client"
OUT="$HERE/www"
[ -d "$SRC" ] || { echo "client/ not found at $SRC" >&2; exit 1; }
cd "$REPO"
rm -rf "$OUT"; mkdir -p "$OUT"
git ls-files client/ \
  | grep -vE 'v2-frozen|\.bak|\.pre-|downloads/|-master\.png|vendor-test\.html|vendor-bridge-test\.html|jsQR\.min\.js' \
  | LC_ALL=C sort > "$OUT/.filelist"
tar cf - -T "$OUT/.filelist" | tar xf - -C "$OUT" --strip-components=1
rm -f "$OUT/.filelist"
# The app boots into the SPA shell; home.html remains the real home view.
cp "$OUT/app.html" "$OUT/index.html"
find "$OUT" -type f -exec touch -h -d '@0' {} +
# Bundle manifest: sha256 of every shipped file + a top hash over the manifest
# body. The top hash is anchored on-chain at release (GBX:R:<tag>:<64-hex>);
# the client can then verify its own bundle against the chain (self-check).
( cd "$OUT" && find . -type f | sed 's|^\./||' | LC_ALL=C sort \
  | xargs sha256sum | LC_ALL=C sort -k2 ) > /tmp/.gbx-manifest-body
TOP=$(sha256sum /tmp/.gbx-manifest-body | cut -d' ' -f1)
python3 - "$OUT" "$TOP" << 'PYEOF'
import json,sys
out,top=sys.argv[1],sys.argv[2]
files={}
for line in open('/tmp/.gbx-manifest-body'):
    h,f=line.split(None,1)
    files[f.strip()]=h
json.dump({"top":top,"files":files},open(out+"/bundle-manifest.json","w"),indent=0,sort_keys=True)
PYEOF
rm -f /tmp/.gbx-manifest-body
touch -h -d '@0' "$OUT/bundle-manifest.json"
echo "bundle top-hash: $TOP"
echo "www: $(find "$OUT" -type f | wc -l) files"
