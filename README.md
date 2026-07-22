# Estuary Atlas

Read-only control-center UI for [Estuary](https://estuary.dev) data
pipelines. Wraps `flowctl` so you never leave the terminal to inspect
captures, collections, materializations, publication history, and live
sample docs.

## Install (via Homebrew tap)

```
brew tap ayyysh04z/atlas
brew install estuary-atlas
estuary-atlas
```

The launcher checks that `flowctl` is installed and authenticated, then
opens the atlas in your browser. Data stays on your machine.

## Local development

```
pnpm install
pnpm run dev
# open http://localhost:5173
```

See `BUILD.md` for packaging + release flow, and `.github/workflows/` for CI.
