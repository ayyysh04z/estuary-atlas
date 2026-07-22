#!/usr/bin/env bash
# Produce a distributable tarball: estuary-atlas-<version>.tar.gz
# Usage: ./scripts/package.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

VERSION="$(node -p "require('./package.json').version")"
NAME="estuary-atlas-v${VERSION}"
DIST="$ROOT/dist"
STAGING="$DIST/$NAME"

echo "▸ Cleaning previous build"
rm -rf "$STAGING" "$DIST/$NAME.tar.gz"
mkdir -p "$STAGING"

echo "▸ Building SvelteKit app"
pnpm run build >/dev/null

echo "▸ Installing production dependencies into staging"
cp package.json pnpm-lock.yaml "$STAGING/"
( cd "$STAGING" && npm install --omit=dev --no-audit --no-fund --silent )

echo "▸ Copying build + launcher"
cp -r build "$STAGING/build"
cp -r bin "$STAGING/bin"
chmod +x "$STAGING/bin/estuary-atlas"

# Top-level convenience symlink so users can just do ./estuary-atlas
ln -s bin/estuary-atlas "$STAGING/estuary-atlas"

# End-user README
cat > "$STAGING/README.txt" <<'README'
Estuary Atlas — internal team build
====================================

Requirements (checked automatically on first run):
  1. Node.js 18+       (brew install node)
  2. flowctl on PATH   (brew install estuary-dev/flowctl/flowctl)
  3. flowctl auth      (flowctl auth login --token <TOKEN>)
     Get a token from: https://dashboard.estuary.dev/admin/api

Run:
  ./estuary-atlas

The launcher checks all prerequisites, starts a local server, and opens
the atlas in your default browser. Ctrl+C to stop.

Ports: uses 5173 by default; auto-increments if busy. Override with:
  ATLAS_PORT=6000 ./estuary-atlas

Everything is read-only. No data leaves your machine.
README

echo "▸ Creating tarball"
( cd "$DIST" && tar czf "$NAME.tar.gz" "$NAME" )

SIZE="$(du -sh "$DIST/$NAME.tar.gz" | awk '{print $1}')"
echo
echo "✔ Package ready:"
echo "    $DIST/$NAME.tar.gz  ($SIZE)"
echo
echo "  Share via Slack/Drive. Recipients:"
echo "    tar xzf $NAME.tar.gz"
echo "    cd $NAME"
echo "    ./estuary-atlas"
