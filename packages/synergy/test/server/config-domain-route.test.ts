import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { Global } from "../../src/global"
import { ScopeContext } from "../../src/scope/context"
import { RuntimeReload } from "../../src/runtime/reload"
import { ConfigRoute } from "../../src/server/config-route"
import { tmpdir } from "../fixture/fixture"

const originalRuntimeReload = RuntimeReload.reload
let originalGeneralConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined
let originalModelsConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined
let originalChannelsConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined

function app() {
  return new Hono().route("/config", ConfigRoute)
}

function patchGeneral(config: unknown) {
  return app().request("/config/domains/general", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
  })
}

function patchModels(config: unknown, mode?: "merge" | "replace-domain" | "append") {
  return app().request("/config/domains/models", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config, mode }),
  })
}

function patchChannels(config: unknown) {
  return app().request("/config/domains/channels", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
  })
}

afterEach(async () => {
  RuntimeReload.reload = originalRuntimeReload
  if (originalGeneralConfig) {
    await Config.domainUpdate("general", originalGeneralConfig, { mode: "replace-domain" })
    originalGeneralConfig = undefined
  }
  if (originalModelsConfig) {
    await Config.domainUpdate("models", originalModelsConfig, { mode: "replace-domain" })
    originalModelsConfig = undefined
  }
  if (originalChannelsConfig) {
    await Config.domainUpdate("channels", originalChannelsConfig, { mode: "replace-domain" })
    originalChannelsConfig = undefined
  }
})

describe.serial("global General config route locale", () => {
  test("accepts every supported locale preference", async () => {
    originalGeneralConfig = await Config.domainGet("general")

    for (const locale of ["system", "en", "zh-CN"] as const) {
      const response = await patchGeneral({ locale })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ locale })
      expect(await Config.domainGet("general")).toMatchObject({ locale })
    }
  })

  test("rejects unsupported locale preferences without updating config", async () => {
    originalGeneralConfig = await Config.domainGet("general")
    await Config.domainUpdate("general", { ...originalGeneralConfig, locale: "en" }, { mode: "replace-domain" })

    for (const locale of ["", "fr", "de-DE"]) {
      const response = await patchGeneral({ locale })
      expect(response.status).toBe(400)
      expect(await Config.domainGet("general")).toMatchObject({ locale: "en" })
    }
  })
})

describe.serial("global Models config route model roles", () => {
  test("reloads role-backed agents after updating a model role", async () => {
    originalModelsConfig = await Config.domainGet("models")
    const previousModel = "kimi-for-coding/k3"
    const nextModel = "deepseek/deepseek-v4-pro"
    await Config.domainUpdate(
      "models",
      { ...originalModelsConfig, thinking_model: previousModel },
      { mode: "replace-domain" },
    )
    const reload = mock(async () => ({
      success: true,
      requested: ["config"] as RuntimeReload.Target[],
      executed: ["config"] as RuntimeReload.Target[],
      cascaded: [] as RuntimeReload.Target[],
      changedFields: ["thinking_model"],
      restartRequired: [],
      liveApplied: ["thinking_model"],
      warnings: [],
      failed: [] as RuntimeReload.Target[],
      failures: [],
      diagnostics: [],
    }))
    RuntimeReload.reload = reload as typeof RuntimeReload.reload

    const response = await patchModels({ thinking_model: nextModel })

    expect(response.status).toBe(200)
    expect(reload).toHaveBeenCalledWith(
      {
        targets: ["config"],
        scope: "global",
        reason: "config.domain.update:models",
      },
      {
        configChange: expect.objectContaining({
          changedFields: ["thinking_model"],
          oldConfig: expect.objectContaining({ thinking_model: previousModel }),
          config: expect.objectContaining({ thinking_model: nextModel }),
        }),
      },
    )
  })

  test("does not reload runtime state for a no-op model update", async () => {
    originalModelsConfig = await Config.domainGet("models")
    const model = "deepseek/deepseek-v4-pro"
    await Config.domainUpdate("models", { ...originalModelsConfig, thinking_model: model }, { mode: "replace-domain" })
    const reload = mock(async () => {
      throw new Error("runtime reload should not run")
    })
    RuntimeReload.reload = reload as unknown as typeof RuntimeReload.reload

    const response = await patchModels({ thinking_model: model })

    expect(response.status).toBe(200)
    expect(reload).not.toHaveBeenCalled()
  })

  test("reloads agents when replace-domain removes a model role", async () => {
    originalModelsConfig = await Config.domainGet("models")
    const previousModel = "deepseek/deepseek-v4-pro"
    await Config.domainUpdate(
      "models",
      { ...originalModelsConfig, thinking_model: previousModel },
      { mode: "replace-domain" },
    )
    let capturedChange: Config.Change | undefined
    const reload = mock(async (_input: RuntimeReload.Input, options?: { configChange?: Config.Change }) => {
      capturedChange = options?.configChange
      return {
        success: true,
        requested: ["config"] as RuntimeReload.Target[],
        executed: ["config"] as RuntimeReload.Target[],
        cascaded: ["agent"] as RuntimeReload.Target[],
        changedFields: ["thinking_model"],
        restartRequired: [],
        liveApplied: ["thinking_model"],
        warnings: [],
        failed: [] as RuntimeReload.Target[],
        failures: [],
        diagnostics: [],
      }
    })
    RuntimeReload.reload = reload as typeof RuntimeReload.reload

    const response = await patchModels({}, "replace-domain")

    expect(response.status).toBe(200)
    expect(reload).toHaveBeenCalledWith(expect.anything(), {
      configChange: expect.objectContaining({
        changedFields: expect.arrayContaining(["thinking_model"]),
        oldConfig: expect.objectContaining({ thinking_model: previousModel }),
      }),
    })
    expect(capturedChange?.config.thinking_model).toBeUndefined()
  })
})

describe.serial("global Channels config route runtime reload", () => {
  test("preserves the Channel change after persisting a Channels domain update", async () => {
    originalChannelsConfig = await Config.domainGet("channels")
    const reload = mock(async () => ({
      success: true,
      requested: ["config"] as RuntimeReload.Target[],
      executed: ["config", "channel"] as RuntimeReload.Target[],
      cascaded: ["channel"] as RuntimeReload.Target[],
      changedFields: ["channel"],
      restartRequired: [],
      liveApplied: [],
      warnings: [],
      failed: [] as RuntimeReload.Target[],
      failures: [],
      diagnostics: [],
    }))
    RuntimeReload.reload = reload as typeof RuntimeReload.reload

    const response = await patchChannels({
      channel: {
        clarus: {
          type: "clarus",
          accounts: { agent: { enabled: true } },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(reload).toHaveBeenCalledWith(
      {
        targets: ["config"],
        scope: "global",
        reason: "config.domain.update:channels",
      },
      {
        configChange: expect.objectContaining({
          changedFields: ["channel"],
          config: expect.objectContaining({
            channel: expect.objectContaining({
              clarus: expect.objectContaining({ type: "clarus" }),
            }),
          }),
        }),
      },
    )
  })
})

describe.serial("config diagnostics route", () => {
  test("returns empty issues when config loads cleanly", async () => {
    Config.resetDiagnostics()
    const response = await app().request("/config/diagnostics")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ issues: [] })
  })

  test("returns recorded issues after a broken fragment is quarantined", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Plant a syntax-broken email fragment in the global domain dir.
        const domainDir = ConfigDomain.directory(Global.Path.config)
        await fs.mkdir(domainDir, { recursive: true })
        await Bun.write(path.join(domainDir, "110-email.jsonc"), "{ broken")
        await Config.reload("global")

        const response = await app().request("/config/diagnostics")
        expect(response.status).toBe(200)
        const body = (await response.json()) as { issues: Config.Issue[] }
        expect(body.issues.length).toBeGreaterThanOrEqual(1)
        expect(body.issues.some((issue) => issue.path.endsWith("110-email.jsonc"))).toBe(true)
        expect(body.issues.some((issue) => issue.quarantined)).toBe(true)
      },
    })
  })
})
