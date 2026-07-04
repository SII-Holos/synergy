#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${SYNERGY_PERF_BASE_URL:-http://127.0.0.1:5817}"
PATH_TO_TEST="${SYNERGY_PERF_PATH:-/global/health}"
DURATION="${SYNERGY_PERF_DURATION:-30s}"
CONNECTIONS="${SYNERGY_PERF_CONNECTIONS:-16}"

if command -v oha >/dev/null 2>&1; then
  exec oha -z "$DURATION" -c "$CONNECTIONS" "$BASE_URL$PATH_TO_TEST"
fi

if command -v bombardier >/dev/null 2>&1; then
  exec bombardier -d "$DURATION" -c "$CONNECTIONS" "$BASE_URL$PATH_TO_TEST"
fi

echo "Install optional oha or bombardier to run HTTP load checks." >&2
exit 1
