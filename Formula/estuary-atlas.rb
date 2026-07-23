# -----------------------------------------------------------------------------
# Homebrew formula for Estuary Atlas.
#
# Push this file to a tap repo (e.g. github.com/ayyysh04z/homebrew-atlas)
# at path Formula/estuary-atlas.rb, then teammates install with:
#
#     brew tap ayyysh04z/atlas         # once
#     brew install estuary-atlas
#     estuary-atlas                    # runs the launcher, opens browser
#
# To publish a new version:
#   1. Bump `version` in package.json
#   2. Run `pnpm run release:brew` (see scripts/release.sh) — it builds the
#      tarball, creates a GitHub release, uploads the asset, and prints the
#      exact `url` + `sha256` lines to update below.
#   3. Commit + push the updated formula to the tap repo.
#
# The formula bundles Node runtime deps into the tarball (see build.sh), so
# only `flowctl` is declared as a runtime dependency here.
# -----------------------------------------------------------------------------
class EstuaryAtlas < Formula
  desc "Read-only control-center UI for Estuary data pipelines"
  homepage "https://github.com/ayyysh04z/homebrew-atlas"
  license "MIT"

  # ─── Release info (bump on every release) ──────────────────────────────────
  version "0.1.14"
  url "https://github.com/ayyysh04z/estuary-atlas/releases/download/v0.1.14/estuary-atlas-v0.1.14.tar.gz"
  sha256 "6cfbd428f2f67f68a4fd8e156213271168c692e542ee9834c5c5feee65551046"
  # ────────────────────────────────────────────────────────────────────────────

  depends_on "node"
  # flowctl is not a public homebrew formula in core — declare it as a
  # runtime requirement via a caveats message rather than depends_on.

  def install
    # The tarball is structured as { bin/, build/, node_modules/, package.json }.
    # We copy the whole app into libexec and wrap the launcher in bin/.
    libexec.install Dir["*"]
    (bin/"estuary-atlas").write <<~SH
      #!/usr/bin/env bash
      exec "#{libexec}/bin/estuary-atlas" "$@"
    SH
    (bin/"estuary-atlas").chmod 0755
  end

  def caveats
    <<~EOS
      Estuary Atlas requires `flowctl` (Estuary's CLI) and an authenticated
      session. Install and log in once:

        brew install estuary-dev/flowctl/flowctl
        flowctl auth login --token <TOKEN_FROM_https://dashboard.estuary.dev/admin/api>

      Then start the atlas — it opens your browser automatically:

        estuary-atlas

      Data is read-only. Nothing leaves your machine.
    EOS
  end

  test do
    assert_predicate bin/"estuary-atlas", :executable?
  end
end
