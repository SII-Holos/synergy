#!/usr/bin/env bun

import { readdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const isolated = new Set(["src/components/session-turn-timeline.test.ts", "src/components/tool/renders/task.test.tsx"])

async function collectTests(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(directory, entry.name)
      if (entry.isDirectory()) return collectTests(relative)
      if (/\.test\.tsx?$/.test(entry.name)) return [relative]
      return []
    }),
  )
  return nested.flat()
}

async function run(files: string[]) {
  if (files.length === 0) return
  const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", ...files], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) globalThis.process.exit(exitCode)
}

const files = [...(await collectTests("test")), ...(await collectTests("src"))].toSorted()
await run(files.filter((file) => !isolated.has(file)))
for (const file of files.filter((file) => isolated.has(file))) await run([file])
