import { cmd } from "./cmd"
import { UI } from "../ui"
import path from "path"
import fs from "fs"
import type { Argv } from "yargs"

// ---------------------------------------------------------------------------
// test [path]
// ---------------------------------------------------------------------------

export const PluginTestCommand = cmd({
  command: "test [path]",
  describe: "run plugin tests",
  builder: (yargs: Argv) =>
    yargs.positional("path", {
      type: "string",
      describe: "path to plugin directory (defaults to cwd)",
    }),
  async handler(args) {
    const pluginDir = path.resolve((args.path as string) ?? process.cwd())

    if (!fs.existsSync(pluginDir)) {
      UI.error(`Directory not found: ${pluginDir}`)
      process.exitCode = 1
      return
    }

    // Check for test files
    const hasTestDir = fs.existsSync(path.join(pluginDir, "test"))
    const testFiles = findTestFiles(pluginDir)

    if (hasTestDir && testFiles.length === 0) {
      // empty test dir
      UI.println(`${UI.Style.TEXT_DIM}No test files found in ${pluginDir}/test/${UI.Style.TEXT_NORMAL}`)
      return
    }

    if (!hasTestDir || testFiles.length === 0) {
      UI.println(
        `${UI.Style.TEXT_DIM}No test directory or test files found in plugin. Add a ${UI.Style.TEXT_NORMAL}test${UI.Style.TEXT_DIM} directory with *.test.ts files.${UI.Style.TEXT_NORMAL}`,
      )
      return
    }

    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Running tests${UI.Style.TEXT_NORMAL} in ${pluginDir}`)
    UI.println(`${UI.Style.TEXT_DIM}Test files found: ${testFiles.join(", ")}${UI.Style.TEXT_NORMAL}`)
    UI.println()

    try {
      const proc = Bun.spawn(["bun", "test"], {
        cwd: pluginDir,
        stdout: "inherit",
        stderr: "inherit",
      })
      const code = await proc.exited
      if (code !== 0) {
        process.exitCode = 1
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      UI.error(`Failed to run tests: ${msg}`)
      process.exitCode = 1
    }
  },
})

function findTestFiles(pluginDir: string): string[] {
  const testDir = path.join(pluginDir, "test")
  if (!fs.existsSync(testDir)) return []
  try {
    return fs
      .readdirSync(testDir)
      .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx") || f.endsWith(".spec.ts"))
  } catch {
    return []
  }
}
