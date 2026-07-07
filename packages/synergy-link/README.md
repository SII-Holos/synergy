# Synergy Link

> ⚠️ **Experimental** — This package is under active development. The API, behavior, and release artifacts may change without notice.

Synergy Link is a lightweight companion CLI that connects to a remote Synergy host — useful when you want to use Synergy as a backend service without running the full local runtime.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/packages/synergy-link/install | bash
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/SII-Holos/synergy/main/packages/synergy-link/install | bash -s -- --version 2.4.3
```

### Options

| Flag               | Description                     |
| ------------------ | ------------------------------- |
| `--version <ver>`  | Install a specific version      |
| `--binary <path>`  | Install from a local binary     |
| `--no-modify-path` | Don't modify shell config files |

### What the installer does

1. Downloads the appropriate binary for your platform (darwin/linux/windows + x64/arm64)
2. Places it under `~/.synergy-link/bin/`
3. Adds that directory to your `PATH` (unless `--no-modify-path` is passed)

## Usage

```bash
synergy-link
```

For usage instructions, run:

```bash
synergy-link --help
```

## Source

Built from this monorepo at `packages/synergy-link/`. Issues and contributions are welcome at [github.com/SII-Holos/synergy](https://github.com/SII-Holos/synergy).
