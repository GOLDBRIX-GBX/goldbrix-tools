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
echo "www: $(find "$OUT" -type f | wc -l) files"
