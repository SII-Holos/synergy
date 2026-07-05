#!/usr/bin/env bun

import { $ } from "bun"

if (!(await hasCommand("gitleaks"))) {
  console.error(
    "gitleaks is required for local secret scanning. Install it with `brew install gitleaks` or use the CI secret-scan job.",
  )
  process.exit(1)
}

await $`gitleaks git --redact --config .gitleaks.toml --verbose`

async function hasCommand(command: string) {
  try {
    await $`which ${command}`.quiet()
    return true
  } catch {
    return false
  }
}
