import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { PluginBuildCommand } from "../../src/cli/cmd/plugin-build"
import { PluginCreateCommand } from "../../src/cli/cmd/plugin-create"
import { PluginPackCommand } from "../../src/cli/cmd/plugin-pack"
import { PluginValidateCommand } from "../../src/cli/cmd/plugin-validate"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const repoNodeModules = path.join(repoRoot, "node_modules")
const templates = ["tool-ui", "workspace-panel", "api-connector", "theme-icon"] as const

async function runCommand(command: { handler: (args: any) => Promise<void> | void }, args: Record<string, unknown>) {
  process.exitCode = undefined
  await command.handler(args as any)
  expect(process.exitCode ?? 0).toBe(0)
}

describe("plugin scaffold toolchain", () => {
  test("generated templates validate, build, and pack with the current plugin API", async () => {
    await using tmp = await tmpdir()
    const previousCwd = process.cwd()
    process.chdir(tmp.path)

    try {
      for (const template of templates) {
        const name = `scaffold-${template}`
        await runCommand(PluginCreateCommand, { name, template })

        const pluginDir = path.join(tmp.path, name)
        await fs.symlink(repoNodeModules, path.join(pluginDir, "node_modules"), "dir")

        await runCommand(PluginValidateCommand, { path: pluginDir, "runtime-discovery": true })
        await runCommand(PluginBuildCommand, { path: pluginDir })
        await runCommand(PluginPackCommand, { path: pluginDir })

        const manifest = await Bun.file(path.join(pluginDir, "dist", "plugin.json")).json()
        expect(manifest.name).toBe(name)
        expect(manifest.main).toBe("./runtime/index.js")
        if (manifest.contributes?.ui?.entry) {
          expect(manifest.contributes.ui.entry).toMatch(/^\.\/ui\/index\.js$/)
          expect(await Bun.file(path.join(pluginDir, "dist", "ui", "index.js")).exists()).toBe(true)
        }
        expect(await Bun.file(path.join(pluginDir, `${name}-0.1.0.synergy-plugin.tgz`)).exists()).toBe(true)
      }
    } finally {
      process.chdir(previousCwd)
      process.exitCode = undefined
    }
  })
})
