# Bundled bwrap binary

This directory holds a statically-linked `bwrap` binary for the target
Linux architecture. In CI/release builds, the binary is placed here
during packaging and the Rust helper discovers it automatically via
`bwrap_binary()`.

## Obtaining a static bwrap binary

### Option A: Build from source

```
git clone https://github.com/containers/bubblewrap
cd bubblewrap
./autogen.sh
./configure LDFLAGS="-static"
make
cp bwrap ../../packages/synergy/src/sandbox/helper-linux/bwrap/
```

### Option B: Download prebuilt

Check the latest release at https://github.com/containers/bubblewrap/releases

## CI integration

In CI, the bwrap binary is downloaded/built as part of the release pipeline
and placed in this directory. The Rust helper's `bwrap_binary()` function
checks this path before falling back to the system `bwrap`.

## Security

Always verify the binary's SHA-256 hash before including it in a release.
