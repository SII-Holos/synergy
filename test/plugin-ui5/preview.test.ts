import { expect, test } from "bun:test"
import path from "node:path"
import { startPluginPreview } from "../../packages/plugin-kit/src/lib/preview"
import { buildMinimalFixture, minimalPluginSource } from "../../packages/plugin-kit/test/fixtures"
import { buildPluginProject } from "../../packages/plugin-kit/src/commands/build"

test("preview starts a real isolated host and removes only its owned home on close", async () => {
  const project = buildMinimalFixture("preview-host")
  project.writeFile("src/index.ts", minimalPluginSource("preview-host"))
  let preview: Awaited<ReturnType<typeof startPluginPreview>> | undefined
  try {
    expect(await buildPluginProject(project.root)).toBe(true)
    preview = await startPluginPreview({
      artifacts: [path.join(project.root, "dist")],
      command: [process.execPath, path.resolve(import.meta.dir, "../../packages/synergy/src/index.ts")],
    })
    expect((await preview.client.global.health()).data?.healthy).toBe(true)
    expect(await (await fetch(preview.url)).text()).toContain("<title>Synergy</title>")
    const home = preview.home
    expect(home).not.toBe(process.env.SYNERGY_HOME)
    await preview.close()
    expect(await Bun.file(path.join(home, ".synergy/config/synergy.d/50-plugins.jsonc")).exists()).toBe(false)
    await preview.close()
  } finally {
    await preview?.close()
    project.cleanup()
  }
}, 90000)
