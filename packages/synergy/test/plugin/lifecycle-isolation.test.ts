import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { ScopeContext } from "../../src/scope/context"

const originalGlobal = Config.global

afterEach(() => {
  ;(Config as any).global = originalGlobal
})

async function writeHookPlugin(
  root: string,
  input: {
    id: string
    hookBody: string
    hookInvocationTimeoutMs?: number
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
        description: "Lifecycle isolation test plugin",
        runtime: {
          mode: "in-process",
          resources: input.hookInvocationTimeoutMs
            ? { hookInvocationTimeoutMs: input.hookInvocationTimeoutMs }
            : undefined,
        },
        permissions: { hooks: { permissionAsk: "all" } },
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
    return {
      "permission.ask": async (_input, output) => {
        ${input.hookBody}
      }
    }
  }
}
`,
  )
  return dir
}

describe("plugin lifecycle isolation", () => {
  test("disables a throwing hook without blocking later plugins or future triggers", async () => {
    await using tmp = await tmpdir({ git: true })
    const badCalls = `__synergyBadHookCalls_${crypto.randomUUID().replaceAll("-", "_")}`
    const goodCalls = `__synergyGoodHookCalls_${crypto.randomUUID().replaceAll("-", "_")}`
    ;(globalThis as any)[badCalls] = 0
    ;(globalThis as any)[goodCalls] = 0
    const badDir = await writeHookPlugin(tmp.path, {
      id: "bad-hook-plugin",
      hookBody: `
        globalThis[${JSON.stringify(badCalls)}] = (globalThis[${JSON.stringify(badCalls)}] ?? 0) + 1
        throw new Error("bad hook failed")
      `,
    })
    const goodDir = await writeHookPlugin(tmp.path, {
      id: "good-hook-plugin",
      hookBody: `
        globalThis[${JSON.stringify(goodCalls)}] = (globalThis[${JSON.stringify(goodCalls)}] ?? 0) + 1
        output.goodHookRan = true
      `,
    })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(badDir).href, pathToFileURL(goodDir).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const loaded = await Plugin.getLoaded()
        expect(loaded.map((plugin) => plugin.id).sort()).toEqual(["bad-hook-plugin", "good-hook-plugin"])
        expect(loaded.map((plugin) => plugin.runtimeMode)).toEqual(["in-process", "in-process"])
        expect(loaded.map((plugin) => Object.keys(plugin.hooks))).toEqual([["permission.ask"], ["permission.ask"]])
        expect(loaded.map((plugin) => plugin.manifest.permissions?.hooks?.permissionAsk)).toEqual(["all", "all"])
        const first: Record<string, unknown> = { decision: "ask" }
        await Plugin.trigger("permission.ask" as any, { tool: "bash" }, first)
        expect((globalThis as any)[badCalls]).toBe(1)
        expect((globalThis as any)[goodCalls]).toBe(1)
        expect(first).toEqual({ decision: "ask", goodHookRan: true })
        expect((await Plugin.getDisabledPlugin("bad-hook-plugin"))?.phase).toBe("hook")

        const second: Record<string, unknown> = { decision: "ask" }
        await Plugin.trigger("permission.ask" as any, { tool: "bash" }, second)
        expect(second).toEqual({ decision: "ask", goodHookRan: true })
        expect((globalThis as any)[badCalls]).toBe(1)
        expect((globalThis as any)[goodCalls]).toBe(2)
      },
    })
  })

  test("keeps permission.ask fail-closed when a plugin hook times out", async () => {
    await using tmp = await tmpdir({ git: true })
    const timeoutDir = await writeHookPlugin(tmp.path, {
      id: "timeout-hook-plugin",
      hookInvocationTimeoutMs: 5,
      hookBody: `
        await new Promise(() => {})
        output.decision = "allow"
      `,
    })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(timeoutDir).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: {
        allowLocalInProcess: true,
        highRiskRequiresProcess: false,
        limits: { hookInvocationTimeoutMs: 5 },
      },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const loaded = await Plugin.getLoaded()
        expect(loaded.map((plugin) => plugin.id)).toEqual(["timeout-hook-plugin"])
        expect(loaded[0]!.runtimeMode).toBe("in-process")
        expect(Object.keys(loaded[0]!.hooks)).toEqual(["permission.ask"])
        expect(loaded[0]!.manifest.permissions?.hooks?.permissionAsk).toBe("all")
        const output: Record<string, unknown> = { decision: "ask" }
        await Plugin.trigger("permission.ask" as any, { tool: "bash" }, output)
        expect(output).toEqual({ decision: "ask" })
        expect((await Plugin.getDisabledPlugin("timeout-hook-plugin"))?.phase).toBe("hook")
      },
    })
  })
})
