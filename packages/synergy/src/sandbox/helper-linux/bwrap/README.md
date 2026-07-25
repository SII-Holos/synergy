# Optional bundled bwrap binary

Linux Stable packages use the system `bubblewrap` package by default. The Debian installer declares it as a dependency. The interactive CLI installer can install it with `apt-get`, `dnf`, or `pacman` after explicit confirmation; non-interactive runs, declined or failed installation, unsupported package managers, and portable archives require manual installation.

The sandbox helper also supports an optional verified binary at:

```text
~/.synergy/sandbox-helper/bwrap/bwrap
```

Use `packages/synergy/scripts/download-bwrap.sh` for source-development experiments. A bundled binary must be architecture-matched and SHA-256 verified before it is distributed. The product Release does not claim that this directory is populated automatically.
