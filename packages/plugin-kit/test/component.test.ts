import { expect, test } from "bun:test"
import { pluginKit } from "../src/component"

test("Plugin Kit contributes author commands only when explicitly selected", async () => {
  const component = pluginKit()
  expect(component.id).toBe("plugin-kit")
  expect(component.requires).toEqual({ "plugin-host": component.version })
  const adapter = await import(component.adapters.cli.href)
  const commands = await adapter.pluginCommands()
  expect(commands.some((item: { command: string }) => item.command.startsWith("create"))).toBe(true)
  expect(commands.some((item: { command: string }) => item.command.startsWith("build"))).toBe(true)
})

test("independently published Kit retains its declared host requirement", async () => {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const os = await import("node:os")
  const { pathToFileURL } = await import("node:url")
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-kit-version-"))
  try {
    await fs.mkdir(path.join(directory, "dist"))
    await fs.copyFile(new URL("../src/component.ts", import.meta.url), path.join(directory, "dist/component.ts"))
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ version: "5.1.0", type: "module", synergy: { requires: { "plugin-host": "4.2.0" } } }),
    )
    const module = await import(pathToFileURL(path.join(directory, "dist/component.ts")).href)
    expect(module.pluginKit()).toMatchObject({ version: "5.1.0", requires: { "plugin-host": "4.2.0" } })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
