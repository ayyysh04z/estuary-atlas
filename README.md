# Estuary Atlas

Read-only control-center UI for [Estuary](https://estuary.dev) data
pipelines. Wraps `flowctl` so you never leave the terminal to inspect
captures, collections, materializations, publication history, and live
sample docs.

## Install (via Homebrew tap)

```
brew tap ayyysh04z/atlas
brew trust ayyysh04z/atlas   # first install only
brew install estuary-atlas
estuary-atlas
```

The launcher checks that `flowctl` is installed and authenticated, then
opens the atlas in your browser. Data stays on your machine.

Upgrade later with `brew upgrade estuary-atlas`.

## Local development

```
pnpm install
pnpm run dev
# open http://localhost:5173
```

## Cutting a new release

```
pnpm run release:patch   # 0.1.0 → 0.1.1
pnpm run release:minor   # 0.1.0 → 0.2.0
pnpm run release:major   # 0.1.0 → 1.0.0
```

Pushes a tag which triggers the [Release workflow](.github/workflows/release.yml)
— it builds the tarball, creates a GitHub release, and auto-updates the
tap formula. Full instructions in **[RELEASE.md](RELEASE.md)**.

## Docs

- **[RELEASE.md](RELEASE.md)** — how to ship a new version to teammates
- **[BUILD.md](BUILD.md)** — local packaging (tarball + Bun single-file binary)
- **[.github/workflows/](.github/workflows/)** — CI + release automation
