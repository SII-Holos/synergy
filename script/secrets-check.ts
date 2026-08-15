#!/usr/bin/env bun

import { $ } from "bun"

if (!(await hasCommand("gitleaks"))) {
  console.error(
    "gitleaks is required for local secret scanning. Install it with `brew install gitleaks` or use the CI secret-scan job.",
  )
  process.exit(1)
}

// CI secret-scan uses a shallow checkout, so it sees only the current tree.
// Align local behavior with that: scan the working tree without full history,
// so long-dead legacy findings (historical test fixtures) cannot block an
// unrelated change. New secrets in the diff still fail the scan.
await $`gitleaks detect --source . --no-git --redact --config .gitleaks.toml --verbose --exit-code 1`

async function hasCommand(command: string) {
  try {
    await $`which ${command}`.quiet()
    return true
  } catch {
    return false
  }
}
