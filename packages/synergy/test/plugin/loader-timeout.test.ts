import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { state as pluginLoaderState } from "../../src/plugin/loader"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const originalGlobal = Config.global

beforeEach(async () => {
  await pluginLoaderState.resetAll()
  await Config.state.resetAll()
})

afterEach(async () => {
  ;(Config as any).global = originalGlobal
  await pluginLoaderState.resetAll()
  await Config.state.resetAll()
  delete (globalThis as any).__synergyLoaderTimeoutCalls
})

async function writePlugin(
  root: string,
  input: {
    id: string
    initBody: string
  },
) {
  const dir = path.join(root, input.id)
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await Bun.write(
    path.join(dir, "plugin.json"),
    JSON.stringify(
      {
        name: input.id,
        version: "0.1.0",
        main: "./src/index.ts",
        description: "Loader timeout test plugin",
        runtime: { mode: "in-process" },
      },
      null,
      2,
    ),
  )
  await Bun.write(
    path.join(dir, "src", "index.ts"),
    `export default {
  id: ${JSON.stringify(input.id)},
  async init() {
    ${input.initBody}
  }
}
`,
  )
  return dir
}

describe("plugin loader startup timeouts", () => {
  test("disables a plugin whose init never returns and continues loading later plugins", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as any).__synergyLoaderTimeoutCalls = []
    const slow = await writePlugin(tmp.path, {
      id: "slow-loader-plugin",
      initBody: "await new Promise(() => {})",
    })
    const good = await writePlugin(tmp.path, {
      id: "good-loader-plugin",
      initBody: `
        globalThis.__synergyLoaderTimeoutCalls.push("good")
        return {}
      `,
    })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(slow).href, pathToFileURL(good).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: {
        allowLocalInProcess: true,
        highRiskRequiresProcess: false,
        limits: { startupTimeoutMs: 25 },
      },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const started = Date.now()
        const loaded = await Plugin.getLoaded()

        expect(Date.now() - started).toBeLessThan(1000)
        expect(loaded.map((plugin) => plugin.id)).toEqual(["good-loader-plugin"])
        expect((globalThis as any).__synergyLoaderTimeoutCalls).toEqual(["good"])

        const disabled = await Plugin.getDisabledPlugin("slow-loader-plugin")
        expect(disabled?.phase).toBe("load")
        expect(disabled?.reason).toContain("Plugin init timed out")
      },
    })
  })
})
