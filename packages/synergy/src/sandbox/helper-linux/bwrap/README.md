# Optional bundled bwrap binary

Linux Stable packages use the system `bubblewrap` package by default. The Debian installer declares it as a dependency; portable and CLI archive users install it with their distribution package manager.

The sandbox helper also supports an optional verified binary at:

```text
~/.synergy/sandbox-helper/bwrap/bwrap
```

Use `packages/synergy/scripts/download-bwrap.sh` for source-development experiments. A bundled binary must be architecture-matched and SHA-256 verified before it is distributed. The product Release does not claim that this directory is populated automatically.
