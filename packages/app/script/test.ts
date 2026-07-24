#!/usr/bin/env bun

import { readdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const isolated = "test/app-build-css-contract.test.ts"
const browserOnly = ["test/pages/fatal-error.test.tsx", "test/plugin/builtin-navigation.test.ts"]

async function collectTests(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true })
  const tests: string[] = []
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name)
    if (entry.isDirectory()) tests.push(...(await collectTests(relative)))
    if (entry.isFile() && /\.test\.(ts|tsx)$/.test(entry.name)) tests.push(relative)
  }
  return tests
}

async function run(tests: string[], options: { browser?: boolean } = {}) {
  const child = Bun.spawn([process.execPath, "test", ...(options.browser ? ["--conditions=browser"] : []), ...tests], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) globalThis.process.exit(exitCode)
}

const tests = (await collectTests("test")).toSorted()
await run(tests.filter((test) => test !== isolated && !browserOnly.includes(test)))
await run(browserOnly, { browser: true })
await run([isolated])
