#!/usr/bin/env bun

import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const files = Array.from(new Bun.Glob("test/plugin-ui5/*.test.ts").scanSync({ cwd: root })).toSorted()
let failed = false

// Separate Bun workers can reap a sibling suite's Chromium or preview host.
for (const file of files) {
  const child = Bun.spawn([process.execPath, "test", "--config", "/dev/null", file], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await child.exited) !== 0) failed = true
}

if (failed) process.exit(1)
