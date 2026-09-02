import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { ConfigRoute } from "../../src/server/config-route"

let originalProvidersConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined
let originalModelsConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined
let originalGeneralConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined

function app() {
  return new Hono().route("/config", ConfigRoute)
}

function exportConfig(query = "") {
  return app().request(`/config/export${query ? `?${query}` : ""}`)
}

afterEach(async () => {
  if (originalProvidersConfig) {
    await Config.domainUpdate("providers", originalProvidersConfig, { mode: "replace-domain" })
    originalProvidersConfig = undefined
  }
  if (originalModelsConfig) {
    await Config.domainUpdate("models", originalModelsConfig, { mode: "replace-domain" })
    originalModelsConfig = undefined
  }
  if (originalGeneralConfig) {
    await Config.domainUpdate("general", originalGeneralConfig, { mode: "replace-domain" })
    originalGeneralConfig = undefined
  }
})

describe("config export route", () => {
  test("redacts provider api keys and mcp secrets over HTTP", async () => {
    originalProvidersConfig = await Config.domainGet("providers")
    await Config.domainUpdate(
      "providers",
      { provider: { custom: { name: "Custom", options: { apiKey: "route-secret" }, models: {} } } },
      { mode: "replace-domain" },
    )

    const redacted = await exportConfig()
    expect(redacted.status).toBe(200)
    const redactedBody = await redacted.json()
    expect(redactedBody.secretsIncluded).toBe(false)
    expect(redactedBody.domains).toContain("providers")
    expect(redactedBody.config.provider.custom.options.apiKey).toBe(Config.REDACTED_SENTINEL)
    expect(Array.isArray(redactedBody.warnings)).toBe(true)

    const explicitFalse = await exportConfig("includeSecrets=false")
    expect(explicitFalse.status).toBe(200)
    expect((await explicitFalse.json()).config.provider.custom.options.apiKey).toBe(Config.REDACTED_SENTINEL)
  })

  test("rejects includeSecrets=true over HTTP instead of returning plaintext", async () => {
    const rejected = await exportConfig("includeSecrets=true")
    expect(rejected.status).toBe(400)
    const body = await rejected.json()
    expect(body.name).toBe("ConfigExportSecretsRejectedError")
    expect(body.data.message).toContain("synergy config export --include-secrets")
  })

  test("rejects unknown includeSecrets values instead of coercing them to true", async () => {
    const invalid = await exportConfig("includeSecrets=1")
    expect(invalid.status).toBe(400)
  })

  test("accepts repeated only parameters and limits the export to those domains", async () => {
    originalProvidersConfig = await Config.domainGet("providers")
    originalModelsConfig = await Config.domainGet("models")
    await Config.domainUpdate(
      "providers",
      { provider: { custom: { name: "Custom", options: { apiKey: "route-secret" }, models: {} } } },
      { mode: "replace-domain" },
    )
    await Config.domainUpdate("models", { model: "test/model" }, { mode: "replace-domain" })

    const single = await exportConfig("only=models")
    expect(single.status).toBe(200)
    const singleBody = await single.json()
    expect(singleBody.domains).toEqual(["models"])
    expect(singleBody.domains).not.toContain("providers")
    expect(singleBody.config.model).toBe("test/model")

    const repeated = await exportConfig("only=models&only=providers")
    expect(repeated.status).toBe(200)
    const repeatedBody = await repeated.json()
    expect(repeatedBody.domains).toEqual(expect.arrayContaining(["models", "providers"]))
  })

  test("rejects an unknown only domain", async () => {
    const invalid = await exportConfig("only=bogus")
    expect(invalid.status).toBe(400)
  })

  test("reports a broken domain file as a warning instead of quarantining it", async () => {
    originalGeneralConfig = await Config.domainGet("general")
    const filepath = ConfigDomain.filepath("general")
    await Bun.write(filepath, "{ this is not valid json")

    try {
      const response = await exportConfig("only=general")
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.warnings.length).toBe(1)
      expect(body.warnings[0]).toContain("general")
      expect(body.domains).toEqual([])
      // Export must not move the broken file aside.
      expect(await Bun.file(filepath).text()).toContain("not valid json")
    } finally {
      await Bun.write(filepath, JSON.stringify(originalGeneralConfig ?? {}, null, 2))
    }
  })
})
