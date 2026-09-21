#!/bin/sh
cat > /app/names.mjs <<'EOF'
export function normalizeName(value) {
  return value.trim().replace(/\s+/gu, " ")
}

export function initials(value) {
  return normalizeName(value).split(" ").map((word) => Array.from(word)[0] ?? "").join("").toUpperCase()
}
EOF
