#!/bin/sh
# Usage:
#   scripts/publish.sh gh-pages                       build and force-push dist/ to the gh-pages branch of "origin"
#   scripts/publish.sh userpage ../<user>.github.io    build and copy into <that repo>/blindspot/ and commit (you push)
set -e
cd "$(dirname "$0")/.."
case "$1" in
  gh-pages)
    scripts/build-pages.sh dist
    REMOTE="$(git remote get-url origin)"
    TMP="$(mktemp -d)"; cp -R dist/. "$TMP/"
    ( cd "$TMP" && git init -q && git checkout -q -b gh-pages && git add -A &&
      git commit -q -m "Deploy Blindspot $(date -u +%Y-%m-%dT%H:%M:%SZ)" && git push -f "$REMOTE" gh-pages )
    rm -rf "$TMP"
    echo "Pushed gh-pages. In GitHub: Settings > Pages > Source: Deploy from a branch > gh-pages / (root)." ;;
  userpage)
    DEST="${2:?usage: scripts/publish.sh userpage <path to your <user>.github.io checkout>}"
    [ -d "$DEST/.git" ] || { echo "$DEST is not a git checkout" >&2; exit 1; }
    scripts/build-pages.sh dist
    rm -rf "$DEST/blindspot"; mkdir -p "$DEST/blindspot"; cp -R dist/. "$DEST/blindspot/"
    ( cd "$DEST" && git add -A blindspot && { git diff --cached --quiet || git commit -q -m "Update Blindspot"; } )
    echo "Committed in $DEST. Now: cd $DEST && git push   ->  https://<user>.github.io/blindspot/" ;;
  *) echo "usage: scripts/publish.sh gh-pages | userpage <path>" >&2; exit 2 ;;
esac
