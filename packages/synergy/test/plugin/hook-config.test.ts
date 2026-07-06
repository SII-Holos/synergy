import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const originalGlobal = Config.global

const secretConfig = {
  provider: {
    openai: {
      options: { apiKey: "provider-secret" },
      models: { "gpt-secret": { options: { apiKey: "model-secret" } } },
    },
  },
  email: {
    smtp: { host: "smtp.example.com", port: 465, secure: true, username: "u", password: "smtp-secret" },
    imap: { host: "imap.example.com", port: 993, secure: true, username: "u", password: "imap-secret" },
  },
  channel: { feishu: { type: "feishu", accounts: { main: { appId: "app", appSecret: "feishu-secret" } } } },
  embedding: { apiKey: "embedding-secret" },
  rerank: { apiKey: "rerank-secret" },
  mcp: { demo: { type: "remote", url: "https://example.com/mcp", oauth: { clientSecret: "mcp-secret" } } },
}

afterEach(() => {
  ;(Config as any).global = originalGlobal
})

async function writeConfigPlugin(
  root: string,
  input: {
    id: string
    configPermission?: boolean
    hookBody?: string
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
        description: "Config hook test plugin",
        runtime: { mode: "in-process" },
        permissions: { hooks: { config: input.configPermission } },
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
      config: async (input, output) => {
        ${input.hookBody ?? "globalThis.__synergyConfigCalls.push({ input, config: output.config })"}
      }
    }
  }
}
`,
  )
  return dir
}

describe("plugin config hooks", () => {
  test("requires explicit config hook permission", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as any).__synergyConfigCalls = []
    const denied = await writeConfigPlugin(tmp.path, { id: "config-denied-plugin" })
    const allowed = await writeConfigPlugin(tmp.path, { id: "config-allowed-plugin", configPermission: true })
    ;(Config as any).global = mock(async () => ({
      ...secretConfig,
      plugin: [pathToFileURL(denied).href, pathToFileURL(allowed).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Plugin.init({ source: "plugin_reload" })
        expect((globalThis as any).__synergyConfigCalls).toHaveLength(1)
        expect((globalThis as any).__synergyConfigCalls[0].input.source).toBe("plugin_reload")
      },
    })
  })

  test("passes changed fields and redacted config on reload notification", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as any).__synergyConfigCalls = []
    const dir = await writeConfigPlugin(tmp.path, { id: "config-redaction-plugin", configPermission: true })
    ;(Config as any).global = mock(async () => ({
      ...secretConfig,
      plugin: [pathToFileURL(dir).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Plugin.getLoaded()
        await Plugin.notifyConfigHooks({ source: "reload", changedFields: ["provider.openai.options.apiKey"] })
        const call = (globalThis as any).__synergyConfigCalls[0]
        expect(call.input.source).toBe("reload")
        expect(call.input.changedFields).toEqual(["provider.openai.options.apiKey"])
        expect(call.input.scopeID).toBeTruthy()
        expect(call.input.timestamp).toBeGreaterThan(0)
        expect(call.config.provider.openai.options.apiKey).toBe(Config.REDACTED_SENTINEL)
        expect(call.config.provider.openai.models["gpt-secret"].options.apiKey).toBe(Config.REDACTED_SENTINEL)
        expect(call.config.email.smtp.password).toBe(Config.REDACTED_SENTINEL)
        expect(call.config.email.imap.password).toBe(Config.REDACTED_SENTINEL)
        expect(call.config.channel.feishu.accounts.main.appSecret).toBe(Config.REDACTED_SENTINEL)
        expect(call.config.embedding.apiKey).toBe(Config.REDACTED_SENTINEL)
        expect(call.config.rerank.apiKey).toBe(Config.REDACTED_SENTINEL)
        expect(call.config.mcp.demo.oauth.clientSecret).toBe(Config.REDACTED_SENTINEL)
      },
    })
  })

  test("config hook snapshots are isolated per plugin", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as any).__synergyConfigCalls = []
    const mutating = await writeConfigPlugin(tmp.path, {
      id: "mutating-config-plugin",
      configPermission: true,
      hookBody: `
        try { output.config.model = "mutated" } catch {}
        try { output.config.provider.openai.options.apiKey = "mutated-secret" } catch {}
        globalThis.__synergyConfigCalls.push(output.config.model)
      `,
    })
    const observing = await writeConfigPlugin(tmp.path, {
      id: "observing-config-plugin",
      configPermission: true,
      hookBody: `globalThis.__synergyConfigCalls.push({ model: output.config.model, apiKey: output.config.provider.openai.options.apiKey })`,
    })
    ;(Config as any).global = mock(async () => ({
      ...secretConfig,
      model: "openai/gpt-4.1",
      plugin: [pathToFileURL(mutating).href, pathToFileURL(observing).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Plugin.notifyConfigHooks({ source: "startup" })
        expect((globalThis as any).__synergyConfigCalls).toEqual([
          "openai/gpt-4.1",
          { model: "openai/gpt-4.1", apiKey: Config.REDACTED_SENTINEL },
        ])
      },
    })
  })

  test("throwing config hook disables only that plugin", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as any).__synergyConfigCalls = []
    const bad = await writeConfigPlugin(tmp.path, {
      id: "bad-config-plugin",
      configPermission: true,
      hookBody: `globalThis.__synergyConfigCalls.push("bad"); throw new Error("config failed")`,
    })
    const good = await writeConfigPlugin(tmp.path, {
      id: "good-config-plugin",
      configPermission: true,
      hookBody: `globalThis.__synergyConfigCalls.push("good")`,
    })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(bad).href, pathToFileURL(good).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Plugin.notifyConfigHooks({ source: "startup" })
        expect((globalThis as any).__synergyConfigCalls).toEqual(["bad", "good"])
        expect((await Plugin.getDisabledPlugin("bad-config-plugin"))?.phase).toBe("hook")
      },
    })
  })
})
