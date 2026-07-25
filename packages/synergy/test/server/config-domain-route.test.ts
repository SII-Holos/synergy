import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "../../src/config/config"
import { RuntimeReload } from "../../src/runtime/reload"
import { ConfigRoute } from "../../src/server/config-route"

const originalRuntimeReload = RuntimeReload.reload
let originalGeneralConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined
let originalModelsConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined

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

function patchModels(config: unknown) {
  return app().request("/config/domains/models", {
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
    await Config.domainUpdate(
      "models",
      { ...originalModelsConfig, thinking_model: "kimi-for-coding/k3" },
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

    const response = await patchModels({ thinking_model: "deepseek/deepseek-v4-pro" })

    expect(response.status).toBe(200)
    expect(reload).toHaveBeenCalledWith(
      {
        targets: ["config"],
        scope: "global",
        reason: "config.domain.update:models",
      },
      {
        changedFields: ["thinking_model"],
      },
    )
  })
})
