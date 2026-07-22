#!/usr/bin/env bun

import path from "node:path"

const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/

export function findMisplacedTestFiles(files: string[], packageRoots: string[]): string[] {
  const normalizedRoots = packageRoots.map((root) => root.replaceAll("\\", "/").replace(/\/$/, ""))

  return files
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => testFilePattern.test(file))
    .filter((file) => {
      const workspaceRoot = normalizedRoots
        .filter((root) => file.startsWith(`${root}/`))
        .toSorted((a, b) => b.length - a.length)[0]
      const packageRoot = workspaceRoot ?? file.match(/^(packages\/[^/]+)\//)?.[1]
      const testRoot = packageRoot ? `${packageRoot}/test/` : "test/"
      return !file.startsWith(testRoot)
    })
    .toSorted()
}

async function main() {
  const root = path.resolve(import.meta.dir, "..")
  const packageJson = await Bun.file(path.join(root, "package.json")).json()
  const packageRoots = packageJson.workspaces?.packages
  if (!Array.isArray(packageRoots) || packageRoots.some((entry) => typeof entry !== "string")) {
    throw new Error("package.json workspaces.packages must be an array of package paths")
  }

  const trackedFiles = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!trackedFiles.success) {
    throw new Error(`git ls-files failed: ${trackedFiles.stderr.toString().trim()}`)
  }

  const misplaced = findMisplacedTestFiles(trackedFiles.stdout.toString().split("\0").filter(Boolean), packageRoots)
  if (misplaced.length === 0) return

  console.error("Test files must live under the owning package's test/ directory or the repository test/ directory:")
  for (const file of misplaced) console.error(`- ${file}`)
  process.exit(1)
}

if (import.meta.main) await main()
