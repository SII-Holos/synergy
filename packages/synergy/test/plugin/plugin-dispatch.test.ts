import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { Config } from "../../src/config/config"
import { registerPluginCommands } from "../../src/cli/plugin-dispatch"

const originalGlobal = Config.global

afterEach(() => {
  ;(Config as any).global = originalGlobal
})

async function writeCliPlugin(dir: string) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await Bun.write(
    path.join(dir, "plugin.json"),
    JSON.stringify(
      { name: "cli-plugin", version: "0.1.0", description: "CLI dispatch test plugin", main: "./src/index.ts" },
      null,
      2,
    ),
  )
  await Bun.write(
    path.join(dir, "src", "index.ts"),
    `export default {
  id: "cli-plugin",
  name: "CLI Plugin",
  async init() {
    return {
      cli: {
        hello: {
          description: "Say hello",
          async execute() { return "hello" }
        }
      }
    }
  }
}
`,
  )
}

describe("plugin CLI dispatch", () => {
  test("registers dynamic plugin commands discovered through the shared file resolver", async () => {
    await using tmp = await tmpdir({ init: writeCliPlugin })
    const entrySpec = pathToFileURL(path.join(tmp.path, "src", "index.ts")).href
    ;(Config as any).global = mock(async () => ({ plugin: [entrySpec] }))

    const commands: any[] = []
    const fakeYargs = {
      command(command: any) {
        commands.push(command)
        return fakeYargs
      },
    }

    await registerPluginCommands(fakeYargs as any)

    expect(commands.map((command) => command.command)).toContain("cli-plugin")
    expect(commands[0].describe).toBe("CLI Plugin")
  })
})
