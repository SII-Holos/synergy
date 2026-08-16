#!/usr/bin/env bun

import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const failedBatches: Array<{ shard: number; exitCode: number }> = []
const isolated = new Set([
  "test/components/message-part-error-boundary.test.ts",
  "test/components/activity-trace.dom.test.ts",
  "test/components/diff-patch.dom.test.ts",
  "test/components/code.dom.test.ts",
  "test/components/compact-reasoning.dom.test.ts",
  "test/components/compact-reasoning-settlement.dom.test.ts",
  "test/components/session-turn-activity.test.ts",
  "test/components/session-turn-activity-switch.dom.test.ts",
  "test/components/session-turn-timeline.test.ts",
  "test/components/session-turn-projection.test.ts",
  "test/components/tool/renders/task.test.tsx",
  "test/components/tool/renders/standard.test.tsx",
  "test/components/tool/renders/file-ops.test.tsx",
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

async function run(files: string[], options: { browser?: boolean } = {}, shard = 0) {
  if (files.length === 0) return
  const coverage = process.argv.includes("--coverage")
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--timeout",
      "120000",
      // Bun overwrites coverage/lcov.info on every invocation, so coverage
      // mode writes each batch into its own shard directory; coverage:check
      // merges them. Without this, the final serial batch would erase all
      // coverage from the main batch.
      ...(coverage ? ["--coverage", "--coverage-reporter=lcov", "--coverage-dir", `coverage/shards/${shard}`] : []),
      ...(options.browser ? ["--conditions=browser"] : []),
      ...files,
    ],
    {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const exitCode = await child.exited
  if (exitCode !== 0) failedBatches.push({ shard, exitCode })
}

const coverage = process.argv.includes("--coverage")
if (coverage) {
  await rm(path.join(root, "coverage", "shards"), { recursive: true, force: true })
  await mkdir(path.join(root, "coverage", "shards"), { recursive: true })
}

const files = (await collectTests("test")).toSorted()
await run(
  files.filter((file) => !isolated.has(file) && !browserOnly.has(file)),
  {},
  0,
)
let shard = 1
for (const file of files.filter((file) => isolated.has(file))) await run([file], {}, shard++)
await run(
  files.filter((file) => browserOnly.has(file)),
  { browser: true },
  shard++,
)
if (failedBatches.length > 0) {
  console.error(
    `test batches failed: ${failedBatches.map(({ shard, exitCode }) => `shard ${shard} (exit ${exitCode})`).join(", ")}`,
  )
  process.exit(1)
}
