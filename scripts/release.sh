#!/usr/bin/env bash
# =============================================================================
#  Estuary Atlas — release helper
# =============================================================================
#
#  What it does (in order):
#    1. Reads `version` from package.json.
#    2. Builds the distributable tarball via scripts/build.sh.
#    3. Computes SHA256 of the tarball.
#    4. Creates a GitHub release `v<version>` on the tap repo, uploads the
#       tarball as an asset (uses `gh` CLI).
#    5. Prints the exact `url` and `sha256` lines to update in
#       Formula/estuary-atlas.rb.
#    6. Optionally patches the formula in place with -w / --write.
#
#  Requirements:
#    - `gh` CLI installed + authenticated (`gh auth login`)
#    - Env var TAP_REPO set (e.g. TAP_REPO=ayyysh04z/homebrew-atlas)
#      OR default = "$(git config user.name)/homebrew-atlas"
#
#  Usage:
#    pnpm run release:brew           # dry — build + print snippet
#    pnpm run release:brew -- -w     # also patch Formula/estuary-atlas.rb
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

WRITE=0
[[ "${1:-}" == "-w" || "${1:-}" == "--write" ]] && WRITE=1

VERSION="$(node -p "require('./package.json').version")"
TAP_REPO="${TAP_REPO:-$(git config user.name 2>/dev/null || echo "REPLACE_ME")/homebrew-atlas}"
TAR="$ROOT/artifacts/dist/estuary-atlas-v${VERSION}.tar.gz"

step()  { printf "\n\033[36m▸\033[0m %s\n" "$*"; }
ok()    { printf "\033[32m✔\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m⚠\033[0m %s\n" "$*"; }
err()   { printf "\033[31m✗\033[0m %s\n" "$*"; }

command -v gh >/dev/null 2>&1 || { err "gh CLI not installed. brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { err "gh not authenticated. Run: gh auth login"; exit 1; }

step "Building tarball (v${VERSION})"
bash scripts/build.sh tarball >/dev/null
[ -f "$TAR" ] || { err "expected $TAR — build failed"; exit 1; }
ok "tarball ready ($(du -sh "$TAR" | awk '{print $1}'))"

step "Computing SHA256"
SHA="$(shasum -a 256 "$TAR" | awk '{print $1}')"
ok "sha256 = $SHA"

step "Creating GitHub release v${VERSION} on ${TAP_REPO}"
if gh release view "v${VERSION}" -R "$TAP_REPO" >/dev/null 2>&1; then
  warn "release v${VERSION} already exists — uploading asset (overwrite)"
  gh release upload "v${VERSION}" "$TAR" -R "$TAP_REPO" --clobber
else
  gh release create "v${VERSION}" "$TAR" \
    -R "$TAP_REPO" \
    --title "Estuary Atlas v${VERSION}" \
    --notes "Internal release."
fi
URL="https://github.com/${TAP_REPO}/releases/download/v${VERSION}/estuary-atlas-v${VERSION}.tar.gz"
ok "asset URL: $URL"

step "Formula snippet"
cat <<SNIP

  version "${VERSION}"
  url "${URL}"
  sha256 "${SHA}"

SNIP

FORMULA="$ROOT/Formula/estuary-atlas.rb"
if [ $WRITE -eq 1 ] && [ -f "$FORMULA" ]; then
  step "Patching $FORMULA"
  # sed -i differs between macOS and Linux; use a portable temp file.
  TMP="$(mktemp)"
  awk -v v="$VERSION" -v u="$URL" -v s="$SHA" '
    /^  version / { print "  version \"" v "\""; next }
    /^  url / { print "  url \"" u "\""; next }
    /^  sha256 / { print "  sha256 \"" s "\""; next }
    { print }
  ' "$FORMULA" > "$TMP"
  mv "$TMP" "$FORMULA"
  ok "formula updated. Now commit + push to ${TAP_REPO}:"
  echo "    cp $FORMULA <clone-of-tap>/Formula/estuary-atlas.rb"
  echo "    cd <clone-of-tap> && git add Formula/estuary-atlas.rb && git commit -m 'release v${VERSION}' && git push"
else
  step "Next steps"
  echo "  1. Copy the version/url/sha256 lines above into Formula/estuary-atlas.rb."
  echo "  2. Push that formula to $TAP_REPO (path Formula/estuary-atlas.rb)."
  echo "  3. Teammates: brew tap ${TAP_REPO%/*}/${TAP_REPO#*/homebrew-} && brew upgrade estuary-atlas"
  echo
  echo "  Re-run with -w to auto-patch the formula in this repo."
fi
