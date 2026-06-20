#!/bin/bash
# Build the Linux sandbox helper from source
# Usage: ./scripts/build-helper.sh [linux|windows]
set -euo pipefail
PLATFORM="${1:-linux}"
cd "$(dirname "$0")/.."
bun run scripts/build-helper.ts "$PLATFORM"
