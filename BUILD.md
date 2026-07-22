# Building & distributing Estuary Atlas

This atlas is a SvelteKit + Node app. It wraps `flowctl` (read-only) so end
users need `flowctl` installed and authenticated — but they do NOT need Node,
pnpm, or any dev tooling to *run* the atlas once you ship it to them.

Two build modes, both driven by `scripts/build.sh`.

---

## 1. Tarball (default — recommended for team internal)

**What it produces:** a `~430 KB` tarball containing the built app + a
launcher script + a tiny production `node_modules/` folder.

**Recipient needs:** `Node 18+`, `flowctl` on PATH, `flowctl auth login` done
once. All three are checked interactively by the launcher on first run and
fail with a helpful "how to install" message if missing.

**Build:**

```bash
pnpm run build:tarball
# or:  bash scripts/build.sh tarball
```

Output → `artifacts/dist/estuary-atlas-v<version>.tar.gz`

(All build artifacts live under `artifacts/` which is git-ignored — safe to
`rm -rf artifacts` anytime.)

**Recipient use:**

```bash
tar xzf estuary-atlas-v0.1.0.tar.gz
cd estuary-atlas-v0.1.0
./estuary-atlas
```

That's it. Launcher:
1. Checks Node ≥ 18
2. Checks `flowctl` is installed
3. Checks `flowctl auth roles list` succeeds
4. Picks a free port (5173, then 5174, 5175 … up to 5200)
5. Boots the SvelteKit server
6. Opens the URL in the default browser

Set `ATLAS_PORT=6000 ./estuary-atlas` to pin a port.

---

## 2. Single-file binary (Bun-compiled)

**What it produces:** ONE ~90 MB executable per target — no Node needed by
the recipient.

**You need:** [`bun`](https://bun.sh) installed locally
(`brew install oven-sh/bun/bun`).

**Recipient needs:** just `flowctl` + auth. Zero Node install.

**Build:**

```bash
pnpm run build:binary
# or:  bash scripts/build.sh binary
```

Outputs three binaries in `artifacts/dist/`:

- `estuary-atlas-macos-arm64` (Apple Silicon)
- `estuary-atlas-macos-x64`   (Intel Macs)
- `estuary-atlas-linux-x64`   (any Linux)

**Recipient use:**

```bash
chmod +x estuary-atlas-macos-arm64
./estuary-atlas-macos-arm64
```

Same auto-open-browser flow as the tarball. Prechecks are baked into the
binary (`scripts/build.sh` inlines a JS entry that does them before booting
the server).

---

## 3. Both at once

```bash
pnpm run build:dist
# or:  bash scripts/build.sh all
```

---

## 4. Homebrew tap (recommended for team-wide distribution)

Team members run:

```bash
brew tap ayyysh04z/atlas         # once — replace with your GH username
brew install estuary-atlas
estuary-atlas                    # opens browser, auto-precheck
```

Updates:

```bash
brew upgrade estuary-atlas
```

### One-time tap setup

1. Create a new public (or private) GitHub repo named exactly
   **`homebrew-atlas`** under your user or org (e.g. `ayyysh04z/homebrew-atlas`).
   The `homebrew-` prefix is mandatory — Homebrew derives the tap name by
   dropping it.
2. Push the file `Formula/estuary-atlas.rb` from this repo to the root of the
   tap repo at that exact path.
3. That's it — teammates can now `brew tap` it.

### Publishing a release

```bash
# 1. Bump package.json:version (e.g. 0.1.0 → 0.1.1)
# 2. Ensure gh CLI is installed + authenticated:
brew install gh && gh auth login

# 3. Set your tap repo (once per shell / add to shellrc):
export TAP_REPO=ayyysh04z/homebrew-atlas

# 4. Cut the release — builds tarball, creates GH release, uploads asset,
#    prints the version/url/sha256 lines:
pnpm run release:brew

# 5. Copy those three lines into Formula/estuary-atlas.rb (or use -w to
#    auto-patch this repo's copy):
pnpm run release:brew -- -w

# 6. Commit the updated formula in the TAP repo (not this one):
#    cd ~/code/homebrew-atlas
#    cp .../atlas/Formula/estuary-atlas.rb Formula/
#    git commit -am "release v0.1.1" && git push
```

Teammates then get the new version on their next `brew upgrade`.

### For private tap repos

If the tap repo is private, teammates need `gh auth login` (or a GH token
with `repo` scope) before `brew tap` — Homebrew will use `git` credentials
to clone. Same install command otherwise.

---

## Distribution

The atlas is 100 % read-only (see the `DANGEROUS` allow-list in
`src/lib/server/flowctl.ts` — `publish/delete/apply/deploy/--push` are
blocked), so you can safely share the artifacts with anyone who already has
`flowctl` credentials for your Estuary tenant.

- **Slack / Google Drive** — just upload `artifacts/dist/estuary-atlas-v0.1.0.tar.gz`
  (or the binary of choice) and paste the "recipient use" snippet above.
- **Internal Homebrew tap** — the tarball can become a formula in ~10 lines;
  ask if you want that.
- **GitHub release (private repo)** — attach both tarball and binaries to a
  tagged release; recipients download from Releases page.

---

## What's inside a tarball (for auditors)

```
estuary-atlas-v0.1.0/
├── bin/estuary-atlas   # bash launcher with prechecks
├── build/              # SvelteKit adapter-node output
│   ├── index.js        # entry point
│   ├── handler.js      # request handler
│   ├── server/         # server code
│   └── client/         # hashed client assets
├── node_modules/       # microdiff only (all other deps are devDeps)
├── package.json
├── pnpm-lock.yaml
├── README.txt          # end-user readme
└── estuary-atlas       # symlink -> bin/estuary-atlas
```

## Versioning

Bump `package.json`:`version`. `scripts/build.sh` picks it up automatically
and stamps the artifact name.
