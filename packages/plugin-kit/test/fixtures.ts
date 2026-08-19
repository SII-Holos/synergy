import fs from "fs"
import path from "path"

export interface FixtureProject {
  root: string
  writeFile(relative: string, content: string): void
  cleanup(): void
}

export function createFixtureProject(prefix: string): FixtureProject {
  const root = fs.mkdtempSync(path.join(import.meta.dir, `${prefix}-`))
  return {
    root,
    writeFile(relative, content) {
      const target = path.join(root, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export function writeMinimalPlugin(project: FixtureProject, source: string, id = "fixture-plugin") {
  project.writeFile(
    "package.json",
    `${JSON.stringify({ name: id, version: "1.0.0", type: "module", source: "./src/index.ts" }, null, 2)}\n`,
  )
  project.writeFile("src/index.ts", source)
}

export function minimalPluginSource(id: string): string {
  return `import { definePlugin } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "${id}",
  version: "1.0.0",
  description: "Coverage fixture",
  contributions: [],
})
`
}

export function buildMinimalFixture(prefix: string, id = "fixture-plugin") {
  const project = createFixtureProject(prefix)
  writeMinimalPlugin(project, minimalPluginSource(id))
  return project
}

export function tarDirectory(sourceDir: string, tarballPath: string, member = "."): boolean {
  const result = Bun.spawnSync(["tar", "-czf", tarballPath, "-C", sourceDir, member], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return result.exitCode === 0
}

export function captureStdoutSync<T>(run: () => T): { output: string; result: T } {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as never
  try {
    const result = run()
    return { output: chunks.join(""), result }
  } finally {
    process.stdout.write = original as never
  }
}

export async function captureStdout<T>(run: () => Promise<T>): Promise<{ output: string; result: T }> {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as never
  try {
    const result = await run()
    return { output: chunks.join(""), result }
  } finally {
    process.stdout.write = original as never
  }
}

export function restoreExitCode(value: number | undefined): void {
  if (value === undefined) {
    process.exitCode = 0
  } else {
    process.exitCode = value
  }
}
