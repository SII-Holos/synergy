import fs from "node:fs/promises"
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
  const modes: Array<{ file: string; mode: number }> = []
  async function readonly(file: string): Promise<void> {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) {
      const target = await fs.realpath(file)
      if (target !== directory && !target.startsWith(directory + path.sep))
        throw new Error("Artifact installation symlink escapes its copied root")
      return
    }
    modes.push({ file, mode: stat.mode & 0o777 })
    if (stat.isDirectory()) for (const child of await fs.readdir(file)) await readonly(path.join(file, child))
    await fs.chmod(file, stat.mode & 0o555)
  }
  async function dispose() {
    try {
      for (const { file, mode } of modes) await fs.chmod(file, mode)
    } finally {
      await isolation.dispose()
    }
  }
  try {
    await fs.cp(path.dirname(path.dirname(binary)), directory, { recursive: true, verbatimSymlinks: true })
    await readonly(directory)
    return { binary: path.join(directory, "bin", path.basename(binary)), dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
