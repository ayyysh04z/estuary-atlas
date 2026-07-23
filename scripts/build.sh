#!/usr/bin/env bash
# =============================================================================
#  Estuary Atlas — build script
# =============================================================================
#
#  Produces distributable artifacts you can share with teammates.
#
#  Two output modes (pick one via first argument):
#
#    ./scripts/build.sh tarball   # DEFAULT — Node-based tarball
#    ./scripts/build.sh binary    # single-file Bun binary (macOS/Linux)
#    ./scripts/build.sh all       # both
#
#  ─── TARBALL MODE ────────────────────────────────────────────────────────────
#  Emits:  dist/estuary-atlas-v<version>.tar.gz   (~450KB)
#  Contents: build/, node_modules/, bin/estuary-atlas launcher, README.txt
#  Recipient needs: Node 18+, flowctl, flowctl auth
#  Recipient runs:
#      tar xzf estuary-atlas-v0.1.0.tar.gz
#      cd estuary-atlas-v0.1.0
#      ./estuary-atlas
#
#  ─── BINARY MODE ─────────────────────────────────────────────────────────────
#  Emits:  dist/estuary-atlas-macos-arm64      (single ~90MB executable)
#          dist/estuary-atlas-macos-x64        (Intel Macs)
#          dist/estuary-atlas-linux-x64        (Linux boxes)
#  Bundles the Bun runtime + all app code into ONE file. Zero Node install
#  needed by the recipient. Still requires flowctl on PATH + auth.
#  Recipient runs:
#      chmod +x estuary-atlas-macos-arm64
#      ./estuary-atlas-macos-arm64
#
#  Requires `bun` locally to build (brew install oven-sh/bun/bun).
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

MODE="${1:-tarball}"
VERSION="$(node -p "require('./package.json').version")"
# All build artifacts (SvelteKit build, tarballs, binaries) live under
# artifacts/ so they can be git-ignored with a single line.
ARTIFACTS="$ROOT/artifacts"
BUILD_DIR="$ARTIFACTS/build"
DIST="$ARTIFACTS/dist"
mkdir -p "$DIST"

step()  { printf "\n\033[36m▸\033[0m %s\n" "$*"; }
ok()    { printf "\033[32m✔\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m⚠\033[0m %s\n" "$*"; }

# -----------------------------------------------------------------------------
# STEP 1 — always: build the SvelteKit app (produces build/)
# -----------------------------------------------------------------------------
build_app() {
  step "Building SvelteKit app (production, adapter-node)"
  pnpm install --silent
  pnpm run build >/dev/null
  ok "built  ($(du -sh "$BUILD_DIR" | awk '{print $1}'))"
}

# -----------------------------------------------------------------------------
# STEP 2a — Node tarball (share via Slack/Drive)
# -----------------------------------------------------------------------------
make_tarball() {
  local NAME="estuary-atlas-v${VERSION}"
  local STAGING="$DIST/$NAME"
  step "Packaging tarball → $NAME.tar.gz"

  rm -rf "$STAGING" "$DIST/$NAME.tar.gz"
  mkdir -p "$STAGING"

  # Copy runtime deps only. The lockfile is required for a reproducible install.
  cp package.json pnpm-lock.yaml "$STAGING/"
  ( cd "$STAGING" && npm install --omit=dev --no-audit --no-fund --silent )

  # Copy SvelteKit build + launcher. The tarball is flat (build/ at top level)
  # even though our dev tree keeps it under artifacts/build/.
  cp -r "$BUILD_DIR" "$STAGING/build"
  cp -r bin "$STAGING/bin"
  # Runtime data (pricing.yaml etc.) — resolved by server code via
  # ../../../data/pricing.yaml relative to src/lib/server/pricing.ts, so it
  # MUST sit alongside the build directory in the packaged layout.
  cp -r data "$STAGING/data"
  chmod +x "$STAGING/bin/estuary-atlas"

  # Convenience: top-level `./estuary-atlas` shortcut
  ( cd "$STAGING" && ln -sf bin/estuary-atlas estuary-atlas )

  # End-user readme (short — the launcher itself surfaces errors interactively)
  cat > "$STAGING/README.txt" <<'READMETXT'
Estuary Atlas — internal team build
====================================

Requirements (checked automatically on first run):
  1. Node.js 18+       (brew install node)
  2. flowctl on PATH   (brew install estuary-dev/flowctl/flowctl)
  3. flowctl auth      (flowctl auth login --token <TOKEN>)
     Get a token from: https://dashboard.estuary.dev/admin/api

Run:
  ./estuary-atlas

The launcher checks prereqs, starts a local server, and opens the atlas
in your default browser. Ctrl+C to stop.

Ports: 5173 by default; auto-increments if busy. Override with:
  ATLAS_PORT=6000 ./estuary-atlas

Everything is read-only. No data leaves your machine.
READMETXT

  ( cd "$DIST" && tar czf "$NAME.tar.gz" "$NAME" )
  ok "tarball  →  $DIST/$NAME.tar.gz  ($(du -sh "$DIST/$NAME.tar.gz" | awk '{print $1}'))"
}

# -----------------------------------------------------------------------------
# STEP 2b — Bun single-file binary (zero Node install for recipient)
# -----------------------------------------------------------------------------
make_binary() {
  if ! command -v bun >/dev/null 2>&1; then
    warn "bun not installed — skipping binary build"
    echo "     Install:  curl -fsSL https://bun.sh/install | bash"
    echo "         or:   brew install oven-sh/bun/bun"
    return
  fi

  # We wrap SvelteKit's build/index.js with a small entry that runs the same
  # precheck flow the shell launcher does — because a single binary has no
  # sibling script to run first.
  step "Writing binary entry (with prechecks)"
  cat > "$DIST/_entry.mjs" <<'ENTRY'
// -----------------------------------------------------------------------------
// Estuary Atlas — single-binary entry
// Runs prechecks (flowctl + auth) then boots the SvelteKit adapter-node server.
// This file is bundled by `bun build --compile` alongside the built app.
// -----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const RED = '\x1b[31m', GRN = '\x1b[32m', YLW = '\x1b[33m', CYA = '\x1b[36m', DIM = '\x1b[2m', RST = '\x1b[0m';
const ok = (m) => console.log(`${GRN}✔${RST} ${m}`);
const err = (m) => console.log(`${RED}✗${RST} ${m}`);
const step = (m) => console.log(`${CYA}▸${RST} ${m}`);

console.log(`\n\x1b[1mEstuary Atlas\x1b[0m\n${DIM}─────────────────────────────────────────${RST}`);

step('Checking flowctl');
const v = spawnSync('flowctl', ['--version']);
if (v.status !== 0) {
  err('flowctl not found on PATH.  Install: brew install estuary-dev/flowctl/flowctl');
  process.exit(1);
}
ok(String(v.stdout).trim().split('\n')[0]);

step('Checking flowctl authentication');
const a = spawnSync('flowctl', ['auth', 'roles', 'list']);
if (a.status !== 0) {
  err('flowctl is not authenticated.');
  console.log('   Get a token: https://dashboard.estuary.dev/admin/api');
  console.log('   Then run:    flowctl auth login --token <TOKEN>');
  process.exit(1);
}
ok('authenticated');

step('Finding free port');
async function freePort(start = 5173) {
  for (let p = start; p < start + 30; p++) {
    const ok = await new Promise((res) => {
      const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(p);
    });
    if (ok) return p;
  }
  throw new Error('no free port');
}
const port = await freePort(Number(process.env.ATLAS_PORT || 5173));
process.env.PORT = String(port);
process.env.HOST = '127.0.0.1';
process.env.ORIGIN = `http://localhost:${port}`;
ok(`using port ${port}`);

// Boot SvelteKit's Node server. Bun will resolve this at compile time.
step(`Starting server at http://localhost:${port}`);
await import('./index.js');

setTimeout(() => {
  const url = `http://localhost:${port}`;
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  spawnSync(opener, [url], { stdio: 'ignore' });
  console.log(`${GRN}✔${RST} opened ${url}   ${DIM}(Ctrl+C to stop)${RST}`);
}, 800);
ENTRY

  # Bun compile per-target. We copy build/ into dist/build/ so the entry can
  # import ./index.js at bundle time.
  rm -rf "$DIST/build" && cp -r "$BUILD_DIR" "$DIST/build"
  cp "$DIST/_entry.mjs" "$DIST/build/_entry.mjs"

  step "Compiling binaries with bun"
  # macOS ARM (Apple Silicon)
  bun build "$DIST/build/_entry.mjs" \
    --compile --target=bun-darwin-arm64 \
    --outfile "$DIST/estuary-atlas-macos-arm64" 2>&1 | tail -3
  ok "macOS arm64  →  $DIST/estuary-atlas-macos-arm64  ($(du -sh "$DIST/estuary-atlas-macos-arm64" | awk '{print $1}'))"

  # macOS Intel
  bun build "$DIST/build/_entry.mjs" \
    --compile --target=bun-darwin-x64 \
    --outfile "$DIST/estuary-atlas-macos-x64" 2>&1 | tail -3
  ok "macOS x64    →  $DIST/estuary-atlas-macos-x64    ($(du -sh "$DIST/estuary-atlas-macos-x64" | awk '{print $1}'))"

  # Linux
  bun build "$DIST/build/_entry.mjs" \
    --compile --target=bun-linux-x64 \
    --outfile "$DIST/estuary-atlas-linux-x64" 2>&1 | tail -3
  ok "linux x64    →  $DIST/estuary-atlas-linux-x64    ($(du -sh "$DIST/estuary-atlas-linux-x64" | awk '{print $1}'))"

  chmod +x "$DIST/estuary-atlas-"*
  rm -f "$DIST/_entry.mjs"
}

# -----------------------------------------------------------------------------
# Dispatch
# -----------------------------------------------------------------------------
build_app

case "$MODE" in
  tarball) make_tarball ;;
  binary)  make_binary ;;
  all)     make_tarball; make_binary ;;
  *) echo "Usage: $0 [tarball|binary|all]"; exit 1 ;;
esac

echo
ok "done"
ls -la "$DIST" | awk '/estuary-atlas/'
