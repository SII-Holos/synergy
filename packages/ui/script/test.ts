#!/usr/bin/env bun

import { readdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const isolated = new Set([
  "test/components/message-part-error-boundary.test.ts",
  "test/components/activity-trace.dom.test.ts",
  "test/components/session-turn-activity.test.ts",
  "test/components/session-turn-activity-switch.dom.test.ts",
  "test/components/session-turn-timeline.test.ts",
  "test/components/session-turn-projection.test.ts",
  "test/components/tool/renders/task.test.tsx",
  "test/components/tool/renders/standard.test.tsx",
  // Chromium-launching tests: run one per process so concurrent browser
  // instances cannot be closed under CI runner resource pressure.
  "test/components/tooltip.test.ts",
  "test/components/provider-icon.test.ts",
])
const browserOnly = new Set(["test/hooks/use-filtered-list.test.tsx"])

async function collectTests(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.posix.join(directory, entry.name)
      if (entry.isDirectory()) return collectTests(relative)
      if (/\.test\.tsx?$/.test(entry.name)) return [relative]
      return []
    }),
  )
  return nested.flat()
}

async function run(files: string[], options: { browser?: boolean } = {}) {
  if (files.length === 0) return
  const child = Bun.spawn(
    [process.execPath, "test", "--timeout", "30000", ...(options.browser ? ["--conditions=browser"] : []), ...files],
    {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const exitCode = await child.exited
  if (exitCode !== 0) globalThis.process.exit(exitCode)
}

const files = (await collectTests("test")).toSorted()
await run(files.filter((file) => !isolated.has(file) && !browserOnly.has(file)))
for (const file of files.filter((file) => isolated.has(file))) await run([file])
await run(
  files.filter((file) => browserOnly.has(file)),
  { browser: true },
)
