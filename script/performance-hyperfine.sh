#!/usr/bin/env bash
set -euo pipefail

if ! command -v hyperfine >/dev/null 2>&1; then
  echo "hyperfine is optional. Install it from https://github.com/sharkdp/hyperfine" >&2
  exit 1
fi

hyperfine --warmup 1 --runs "${SYNERGY_HYPERFINE_RUNS:-5}" \
  'bun dev --help' \
  'bun run --cwd packages/synergy src/index.ts --help'
