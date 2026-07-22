# Releasing Estuary Atlas

End-to-end release flow for pushing a new version to your teammates' `brew`
installs.

## Repos

Two GitHub repos are involved:

| Repo | Purpose | Contents |
|---|---|---|
| `ayyysh04z/estuary-atlas` | Source of truth | App code, workflows, `Formula/estuary-atlas.rb` source template, versioned releases (with tarball assets) |
| `ayyysh04z/homebrew-atlas` | Homebrew tap | ONE file: `Formula/estuary-atlas.rb`, pointing at the source repo's release tarball |

The second repo is required because Homebrew's `brew tap` command only
recognises repos named `homebrew-*`.

---

## First-time setup (only done once, already complete)

You do NOT need to redo these — noted here for reference.

1. Created source repo `ayyysh04z/estuary-atlas` via `gh repo create`.
2. Created tap repo `ayyysh04z/homebrew-atlas` via `gh repo create --add-readme`.
3. Pushed initial code + Formula.
4. Cut v0.1.0 release, uploaded tarball to source repo's release, patched
   tap formula, pushed tap.

## One-time setup you still need to do — `TAP_PUSH_TOKEN`

The GitHub Actions release workflow needs write access to the tap repo to
push the formula update. Create a Personal Access Token and store it as a
secret:

1. Go to https://github.com/settings/tokens/new
2. Note: `TAP_PUSH_TOKEN for estuary-atlas`
3. Expiration: 1 year (or your preference)
4. Scopes: check just `repo`
5. Generate → copy the token
6. Add it as a secret on the source repo:

   ```
   gh secret set TAP_PUSH_TOKEN --repo ayyysh04z/estuary-atlas
   # paste token when prompted
   ```

   or via UI: https://github.com/ayyysh04z/estuary-atlas/settings/secrets/actions

Until you set this secret, the workflow will still create GitHub releases,
but will emit a warning and skip the tap update — you'd have to bump the
formula manually.

---

## Cutting a release (once per version)

### Option A — automated via GitHub Actions (recommended)

```bash
# From atlas/ directory:
pnpm run release:patch     # 0.1.0 → 0.1.1
# or:
pnpm run release:minor     # 0.1.0 → 0.2.0
# or:
pnpm run release:major     # 0.1.0 → 1.0.0
```

That script:
1. Bumps `package.json:version`
2. Commits the bump on `main`
3. Creates an annotated git tag `v<version>`
4. Pushes both branch and tag to `origin`
5. Exits — the workflow takes over from here.

The [Release workflow](.github/workflows/release.yml) then:
1. Builds `artifacts/dist/estuary-atlas-v<version>.tar.gz`
2. Creates a GitHub release on the source repo with the tarball as an asset
3. Clones the tap repo (using `TAP_PUSH_TOKEN`)
4. Patches `Formula/estuary-atlas.rb` (version + url + sha256)
5. Commits + pushes the tap update

Watch it run:

```bash
gh run watch -R ayyysh04z/estuary-atlas
```

### Option B — fully local (no Actions)

Useful when Actions is down, or for a hotfix from your laptop:

```bash
export TAP_REPO=ayyysh04z/homebrew-atlas
export SOURCE_REPO=ayyysh04z/estuary-atlas

# Manually bump package.json version first, then:
pnpm run release:brew -- --write

# Then push the patched formula to the tap:
cd /tmp && gh repo clone ayyysh04z/homebrew-atlas
cp ~/…/atlas/Formula/estuary-atlas.rb homebrew-atlas/Formula/
cd homebrew-atlas && git commit -am "release vX.Y.Z" && git push
```

---

## What teammates do

```bash
# One time:
brew tap ayyysh04z/atlas
brew install estuary-atlas
brew trust ayyysh04z/atlas    # first install only — newer Homebrew asks

# Ongoing:
brew upgrade estuary-atlas
estuary-atlas                 # opens the UI in the browser
```

---

## Troubleshooting

**`Formula reports different checksum`** — the tarball on the release
doesn't match the sha256 in the formula. Cause: the tarball was rebuilt
non-deterministically between upload and formula patch. Fix: re-download
the actual asset, compute its sha, patch the formula.

```bash
gh release download vX.Y.Z -R ayyysh04z/estuary-atlas -p '*.tar.gz' -O /tmp/x.tar.gz --clobber
shasum -a 256 /tmp/x.tar.gz   # copy this into Formula/estuary-atlas.rb
```

**`Refusing to load formula … from untrusted tap`** — Homebrew's new
security check. First-time trust:

```bash
brew trust ayyysh04z/atlas
```

**`gh: not authenticated`** — run `gh auth login` before any release
script.

**Workflow "TAP_PUSH_TOKEN not set — skipping tap update"** — add the
secret per the instructions above and re-run the workflow, or bump the
formula manually.

---

## File map

| File | Purpose |
|---|---|
| `.github/workflows/release.yml` | Tag-triggered release + tap update |
| `.github/workflows/ci.yml` | Build check on push/PR |
| `Formula/estuary-atlas.rb` | Source template for the tap formula |
| `bin/estuary-atlas` | Launcher packaged into the tarball |
| `scripts/build.sh` | Builds the tarball / Bun binaries |
| `scripts/release.sh` | Version-bump + tag-push helper |
| `BUILD.md` | Manual packaging + Bun binary docs |
| `RELEASE.md` | This file |
