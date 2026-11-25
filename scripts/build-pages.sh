#!/bin/sh
# Build the Wasm core and assemble the static site (all paths are relative, so it works at
# https://<user>.github.io/  or  https://<user>.github.io/blindspot/).
# Usage: scripts/build-pages.sh [outdir]      default outdir: dist   (use "docs" for Pages "deploy from /docs")
set -e
cd "$(dirname "$0")/.."
OUT="${1:-dist}"
command -v wasm-pack >/dev/null 2>&1 || { echo "wasm-pack not found: cargo install wasm-pack" >&2; exit 1; }
(cd core && wasm-pack build --target web --release --out-dir ../web/pkg)
STAMP="$(git rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%s)"
rm -rf "$OUT"; mkdir -p "$OUT/pkg"
for f in index.html 404.html app.js sender.js receiver.js rx-worker.js layout.js link.js manifest.webmanifest; do cp "web/$f" "$OUT/"; done
cp web/pkg/blindspot_core.js web/pkg/blindspot_core_bg.wasm "$OUT/pkg/"    # NOT pkg/.gitignore (wasm-pack writes '*' there)
sed "s/__BUILD__/$STAMP/" web/sw.js > "$OUT/sw.js"                          # new cache name per build so updates reach users
touch "$OUT/.nojekyll"                                                       # tell Pages: no Jekyll processing
echo "Built $OUT (build $STAMP)"
