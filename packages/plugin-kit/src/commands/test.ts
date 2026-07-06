import path from "path"
import fs from "fs"
import type { Argv } from "yargs"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"

function findTestFiles(pluginDir: string): string[] {
  const testDir = path.join(pluginDir, "test")
  if (!fs.existsSync(testDir)) return []
  return fs
    .readdirSync(testDir)
    .filter((file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file.endsWith(".spec.ts"))
}

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

    const testFiles = findTestFiles(pluginDir)
    if (testFiles.length === 0) {
      UI.println(
        `${UI.Style.TEXT_DIM}No plugin tests found. Add test/*.test.ts files and rerun synergy-plugin test.${UI.Style.TEXT_NORMAL}`,
      )
      return
    }

    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Running tests${UI.Style.TEXT_NORMAL} in ${pluginDir}`)
    UI.println(`${UI.Style.TEXT_DIM}Test files found: ${testFiles.join(", ")}${UI.Style.TEXT_NORMAL}`)
    UI.println()

    const proc = Bun.spawn(["bun", "test"], { cwd: pluginDir, stdout: "inherit", stderr: "inherit" })
    const code = await proc.exited
    if (code !== 0) process.exitCode = 1
  },
})
