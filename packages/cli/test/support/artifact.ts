import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

const scenarios = ["complete", "tool", "read", "budget", "timeout", "permission"] as const
type Scenario = (typeof scenarios)[number]

export function artifactScenarios(selection?: string): Scenario[] {
  if (selection === undefined) return [...scenarios]
  const error = new Error("SYNERGY_TEST_ARTIFACT_SCENARIOS must be a nonempty JSON array of unique scenario IDs")
  let values: unknown
  try {
    values = JSON.parse(selection)
  } catch {
    throw error
  }
  if (
    !Array.isArray(values) ||
    !values.length ||
    new Set(values).size !== values.length ||
    !values.every((value) => scenarios.some((scenario) => scenario === value))
  ) {
    throw error
  }
  return values as Scenario[]
}

export async function stageArtifactInstallation(binary: string) {
  const isolation = await createIsolatedTestEnv()
  const directory = path.join(await fs.realpath(isolation.env.SYNERGY_TEST_ROOT!), "installation")
  async function inventory() {
    const entries: Array<{ path: string; mode: number; content: string }> = []
    async function visit(file: string): Promise<void> {
      const stat = await fs.lstat(file)
      const entry = { path: path.relative(directory, file), mode: stat.mode & 0o777, content: "directory" }
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(file)
        if (target !== directory && !target.startsWith(directory + path.sep))
          throw new Error("Artifact installation symlink escapes its copied root")
        entry.content = "link:" + (await fs.readlink(file))
      } else if (stat.isFile()) {
        const digest = createHash("sha256")
        for await (const chunk of createReadStream(file)) digest.update(chunk)
        entry.content = digest.digest("hex")
      } else if (!stat.isDirectory()) throw new Error("Unsupported artifact installation entry")
      entries.push(entry)
      if (stat.isDirectory()) for (const child of (await fs.readdir(file)).sort()) await visit(path.join(file, child))
    }
    await visit(directory)
    return JSON.stringify(entries)
  }
  try {
    await fs.cp(path.dirname(path.dirname(binary)), directory, { recursive: true, verbatimSymlinks: true })
    const expected = await inventory()
    return {
      binary: path.join(directory, "bin", path.basename(binary)),
      async dispose() {
        try {
          if ((await inventory()) !== expected) throw new Error("Shared artifact installation changed")
        } finally {
          await isolation.dispose()
        }
      },
    }
  } catch (error) {
    await isolation.dispose()
    throw error
  }
}
