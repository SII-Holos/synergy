#!/bin/bash
# Download a static bwrap binary for Linux x86_64
# Usage: ./scripts/download-bwrap.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BWRAP_DIR="packages/synergy/src/sandbox/helper-linux/bwrap"
BWRAP_BIN="$BWRAP_DIR/bwrap"

echo "Downloading static bwrap binary..."
# On macOS with brew: brew install bubblewrap (not static, for dev only)
# For release: build from source with LDFLAGS=-static
echo "Place a static bwrap binary at: $BWRAP_BIN"
echo "See $BWRAP_DIR/README.md for build instructions"
