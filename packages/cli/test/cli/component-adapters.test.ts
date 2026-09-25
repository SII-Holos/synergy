import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadCliAdapters } from "../../src/cli/components"

test("selected components contribute lazy commands and nested command groups", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-cli-adapter-"))
  try {
    const entry = path.join(directory, "adapter.js")
    await Bun.write(
      entry,
      `export const commands = [{ command: "example", describe: "example", load: async () => ({ command: "example", handler() {} }) }]; export const pluginCommands = async () => [{ command: "build", handler() {} }];`,
    )
    const context = {
      openHttp: async () => {
        throw new Error("No runtime should start during command discovery")
      },
    }
    expect((await loadCliAdapters([], context)).commands).toEqual([])
    const component = {
      id: "example",
      version: "2.0.0",
      apiVersion: 1 as const,
      register() {},
      adapters: { cli: pathToFileURL(entry) },
    }
    const selected = await loadCliAdapters([component], context)
    expect(selected.commands.map((item) => item.command)).toEqual(["example"])
    expect((await selected.pluginCommands()).map((item) => item.command)).toEqual(["build"])
    expect(await selected.debugCommands()).toEqual([])
    expect(await selected.dataCommands()).toEqual([])
    await expect(loadCliAdapters([component, { ...component, id: "conflict" }], context)).rejects.toThrow("duplicate")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
