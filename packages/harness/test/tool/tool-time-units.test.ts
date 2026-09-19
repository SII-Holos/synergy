import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

/**
 * Repository-level policy assertion for the tool time-budget contract, so the
 * seconds-at-the-boundary rule cannot silently drift back. It reads source,
 * prompt, and tool-description text on purpose: the renamed parameter names and
 * the removed one span packages, and no toolchain gate scans prose or tool
 * output strings for units.
 *
 * Deliberately NOT covered here, because their millisecond values are locked
 * contracts rather than boundary copy: `settleTimeoutMs` (browser protocol and
 * its `Settled:` summary), the agenda `timeout` field and its run logs, and the
 * cortex task runtime limit. Widening this list means changing a published or
 * persisted contract, not tightening a convention.
 */
const repoRoot = path.resolve(import.meta.dir, "../../../..")

const PROMPT_FILES = [
  "packages/harness/src/agent/prompt/developer/base.txt",
  "packages/harness/src/agent/prompt/synergy/base.txt",
  "packages/harness/src/agent/prompt/synergy-max/base.txt",
]

const SECONDS_FACING_TOOL_FILES = [
  "packages/runtime-local/src/tools/scan-files.ts",
  "packages/runtime-local/src/tools/scan-files.txt",
  "packages/runtime-local/src/tools/glob.ts",
  "packages/runtime-local/src/tools/ls.ts",
  "packages/browser-runtime/src/tools/browser-wait.ts",
  "packages/browser-runtime/src/tools/browser-eval.ts",
  "packages/browser-runtime/src/tools/browser-downloads.ts",
  "packages/runtime-local/src/tools/webfetch.ts",
  "packages/runtime-local/src/tools/process.ts",
  "packages/runtime-local/src/tools/process.txt",
  "packages/harness/src/cortex/tools/task-output.ts",
  "packages/media/src/tools/lookat.ts",
  "packages/media/src/tools/lookat.txt",
]

async function read(relative: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relative), "utf8")
}

async function collect(directory: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(repoRoot, directory), { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.posix.join(directory, entry.name)
      if (entry.isDirectory()) return collect(relative)
      return /\.(ts|txt)$/.test(entry.name) ? [relative] : []
    }),
  )
  return nested.flat().sort()
}

describe("tool time-budget units", () => {
  test("no source or prompt file reads the bash timing argument the schema never exposed", async () => {
    const files = [
      ...(await collect("packages/harness/src/agent/prompt")),
      ...(await collect("packages/runtime-local/src/tools")),
      ...(await collect("packages/harness/src/tool")),
    ]
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const body = await read(file)
      if (body.includes("backgroundAfterSeconds")) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("agent prompts teach behavior instead of naming the process wait parameter", async () => {
    const offenders: string[] = []
    for (const file of PROMPT_FILES) {
      const body = await read(file)
      if (body.includes("timeoutSeconds")) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("agent-facing tool files express durations in seconds, never ms or ns", async () => {
    const offenders: string[] = []
    for (const file of SECONDS_FACING_TOOL_FILES) {
      const body = await read(file)
      // An interpolated value immediately followed by a millisecond or
      // nanosecond unit; internal identifiers like `timeoutMs` are not units.
      if (/\}\s*(ms|ns)\b/.test(body)) offenders.push(`${file}: interpolated ms/ns unit`)
      if (/milliseconds|microseconds|nanoseconds/i.test(body)) offenders.push(`${file}: spelled-out sub-second unit`)
    }
    expect(offenders).toEqual([])
  })
})
