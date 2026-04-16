# MetaSynergy

> ⚠️ **Experimental** — This package is under active development. The API, behavior, and release artifacts may change without notice.

MetaSynergy is a lightweight companion CLI that connects to a remote Synergy host — useful when you want to use Synergy as a backend service without running the full local runtime.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/packages/meta-synergy/install | bash
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/packages/meta-synergy/install | bash -s -- --version 1.1.26
```

### Options

| Flag               | Description                     |
| ------------------ | ------------------------------- |
| `--version <ver>`  | Install a specific version      |
| `--binary <path>`  | Install from a local binary     |
| `--no-modify-path` | Don't modify shell config files |

### What the installer does

1. Downloads the appropriate binary for your platform (darwin/linux/windows + x64/arm64)
2. Places it under `~/.meta-synergy/bin/`
3. Adds that directory to your `PATH` (unless `--no-modify-path` is passed)

## Usage

```bash
meta-synergy
```

For usage instructions, run:

```bash
meta-synergy --help
```

## Source

Built from this monorepo at `packages/meta-synergy/`. Issues and contributions are welcome at [github.com/SII-Holos/synergy](https://github.com/SII-Holos/synergy).
