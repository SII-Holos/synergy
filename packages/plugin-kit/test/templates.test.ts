import { expect, test } from "bun:test"
import path from "node:path"
import { PLUGIN_TEMPLATES, scaffoldPluginProject } from "../src/commands/create"
import { buildPluginProject } from "../src/commands/build"
import { packPluginProject } from "../src/commands/pack"
import { createFixtureProject } from "./fixtures"

for (const template of PLUGIN_TEMPLATES)
  test(`${template} builds, typechecks its public contract and packs`, async () => {
    const project = createFixtureProject(`template-${template}`)
    try {
      scaffoldPluginProject(`example-${template}`, template, project.root)
      expect(await buildPluginProject(project.root)).toBe(true)
      const compiler = Bun.spawn(
        [
          process.execPath,
          path.resolve(import.meta.dir, "../../../node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--project",
          project.root,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const output = await new Response(compiler.stdout).text()
      expect(await compiler.exited, output).toBe(0)
      expect(await Bun.file(packPluginProject(project.root)).exists()).toBe(true)
    } finally {
      project.cleanup()
    }
  }, 30000)
