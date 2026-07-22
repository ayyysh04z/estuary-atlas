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
TAG_ONLY=0
BUMP=""
for arg in "$@"; do
  case "$arg" in
    -w|--write)     WRITE=1 ;;
    --tag-only)     TAG_ONLY=1 ;;
    --patch|--minor|--major) BUMP="${arg#--}" ;;
    -h|--help)
      cat <<'HELP'
Usage: release.sh [--patch|--minor|--major] [-w] [--tag-only]

Options:
  --patch|--minor|--major   Bump package.json version first (uses `npm version`),
                            create a git tag, and push it.
  -w, --write               After release, patch this repo's Formula/*.rb file.
  --tag-only                Create + push the git tag only. The workflow will
                            build & publish. Recommended for CI-driven release.

Env vars:
  SOURCE_REPO   default: current repo via gh (or ayyysh04z/estuary-atlas)
  TAP_REPO      default: ayyysh04z/homebrew-atlas
HELP
      exit 0 ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
# Source repo = where releases live (with tarball assets).
# Tap repo = where the Homebrew Formula/*.rb lives.
SOURCE_REPO="${SOURCE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "ayyysh04z/estuary-atlas")}"
TAP_REPO="${TAP_REPO:-ayyysh04z/homebrew-atlas}"
TAR="$ROOT/artifacts/dist/estuary-atlas-v${VERSION}.tar.gz"

step()  { printf "\n\033[36m▸\033[0m %s\n" "$*"; }
ok()    { printf "\033[32m✔\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m⚠\033[0m %s\n" "$*"; }
err()   { printf "\033[31m✗\033[0m %s\n" "$*"; }

command -v gh >/dev/null 2>&1 || { err "gh CLI not installed. brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { err "gh not authenticated. Run: gh auth login"; exit 1; }

# ── 0. Version bump (optional) ─────────────────────────────────────────────
if [ -n "$BUMP" ]; then
  step "Bumping version ($BUMP)"
  # npm version does: update package.json, git commit, git tag
  npm version "$BUMP" --no-git-tag-version >/dev/null
  NEW_VERSION="$(node -p "require('./package.json').version")"
  git add package.json
  # Only commit if there are changes
  if ! git diff --cached --quiet; then
    git commit -q -m "release: v${NEW_VERSION}"
    ok "committed v${NEW_VERSION}"
  fi
  VERSION="$NEW_VERSION"
  TAR="$ROOT/artifacts/dist/estuary-atlas-v${VERSION}.tar.gz"
fi

# ── 1. Git tag (idempotent) ────────────────────────────────────────────────
TAG="v${VERSION}"
step "Ensuring git tag ${TAG}"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  ok "tag ${TAG} already exists locally"
else
  git tag -a "$TAG" -m "Estuary Atlas ${TAG}"
  ok "created tag ${TAG}"
fi
# Push tag (and any pending commits)
step "Pushing branch + tag to origin"
git push -q origin HEAD 2>&1 | tail -3 || warn "branch push had issues"
git push -q origin "$TAG" 2>&1 | tail -3 || warn "tag push had issues (may already exist upstream)"
ok "pushed"

if [ $TAG_ONLY -eq 1 ]; then
  echo
  ok "Tag pushed — GitHub Actions release workflow will now build + publish."
  echo "   Watch: gh run watch -R ${SOURCE_REPO}"
  exit 0
fi

step "Building tarball (v${VERSION})"
bash scripts/build.sh tarball >/dev/null
[ -f "$TAR" ] || { err "expected $TAR — build failed"; exit 1; }
ok "tarball ready ($(du -sh "$TAR" | awk '{print $1}'))"

step "Computing SHA256"
SHA="$(shasum -a 256 "$TAR" | awk '{print $1}')"
ok "sha256 = $SHA"

step "Creating GitHub release v${VERSION} on ${SOURCE_REPO}"
if gh release view "v${VERSION}" -R "$SOURCE_REPO" >/dev/null 2>&1; then
  warn "release v${VERSION} already exists — uploading asset (overwrite)"
  gh release upload "v${VERSION}" "$TAR" -R "$SOURCE_REPO" --clobber
else
  gh release create "v${VERSION}" "$TAR" \
    -R "$SOURCE_REPO" \
    --title "Estuary Atlas v${VERSION}" \
    --notes "Internal release."
fi
URL="https://github.com/${SOURCE_REPO}/releases/download/v${VERSION}/estuary-atlas-v${VERSION}.tar.gz"
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
