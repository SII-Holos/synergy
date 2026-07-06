#!/usr/bin/env bun

const pkg = (await Bun.file("package.json").json()) as { packageManager?: string }
const expected = pkg.packageManager?.match(/^bun@(.+)$/)?.[1]
if (!expected) {
  console.error("package.json must declare packageManager as bun@<version>.")
  process.exit(1)
}

const current = Bun.version
if (current !== expected) {
  console.error(`Bun version ${current} does not match package.json packageManager bun@${expected}.`)
  process.exit(1)
}
