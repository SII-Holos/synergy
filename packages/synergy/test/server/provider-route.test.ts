import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Server } from "../../src/server/server"
import { Auth } from "../../src/provider/api-key"
import { CodexProvider } from "../../src/provider/codex"
import { CopilotProvider } from "../../src/provider/copilot"
import { tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"
import { ProviderCatalog } from "../../src/provider/catalog"
import { Global } from "../../src/global"
import { Config } from "../../src/config/config"

const originalCodexHome = process.env.CODEX_HOME
const originalOpenAIAPIKey = process.env.OPENAI_API_KEY
const originalFetch = globalThis.fetch
let isolatedCodexHome: string | undefined

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function makeJWT(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.signature`
}

function accessToken() {
  return makeJWT({
    exp: nowSeconds() + 60 * 60,
    "https://api.openai.com/auth.chatgpt_account_id": "acct_provider_route",
  })
}

function restoreCodexHome() {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
}

function restoreOpenAIAPIKey() {
  if (originalOpenAIAPIKey === undefined) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIAPIKey
  }
}

async function reset() {
  globalThis.fetch = originalFetch
  if (isolatedCodexHome) await fs.rm(isolatedCodexHome, { recursive: true, force: true })
  isolatedCodexHome = path.join(os.tmpdir(), `synergy-provider-route-codex-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(isolatedCodexHome, { recursive: true })
  process.env.CODEX_HOME = isolatedCodexHome
  process.env.OPENAI_API_KEY = "provider-route-openai-key"
  await Auth.remove(CodexProvider.PROVIDER_ID).catch(() => {})
  await fs.rm(Global.Path.providerModelCatalogCache, { force: true })
  ProviderCatalog.reset()
  await Provider.reload()
}

beforeEach(reset)
afterEach(async () => {
  globalThis.fetch = originalFetch
  await Auth.remove(CodexProvider.PROVIDER_ID).catch(() => {})
  await Provider.reload()
  if (isolatedCodexHome) await fs.rm(isolatedCodexHome, { recursive: true, force: true })
  isolatedCodexHome = undefined
  restoreCodexHome()
  restoreOpenAIAPIKey()
})

test("/provider returns catalog, auth health, and runtime availability", async () => {
  const app = Server.App()
  const response = await app.request("/provider")
  expect(response.status).toBe(200)
  const body = await response.json()

  expect(body.all.some((provider: any) => provider.id === CodexProvider.PROVIDER_ID)).toBe(true)
  expect(body.catalogProviders).toContain(CodexProvider.PROVIDER_ID)
  expect(body.authHealth.github.providerID).toBe("github")
  expect(body.authHealth[CodexProvider.PROVIDER_ID]).toMatchObject({
    providerID: CodexProvider.PROVIDER_ID,
    status: "not_configured",
  })
  expect(body.authHealth[CodexProvider.PROVIDER_ID].canDisconnect).toBe(false)
  expect(body.runtimeAvailability[CodexProvider.PROVIDER_ID]).toMatchObject({
    providerID: CodexProvider.PROVIDER_ID,
    available: false,
    reason: "not_connected",
  })
  expect(body.modelCatalog[CodexProvider.PROVIDER_ID]).toMatchObject({
    source: "bundled",
    modelCount: 5,
  })
  expect(body.modelCatalog.openai).toBeUndefined()
  expect(body.profiles[CodexProvider.PROVIDER_ID]).toMatchObject({
    id: CodexProvider.PROVIDER_ID,
    recommendation: {
      level: "recommended",
      rank: 20,
    },
  })
  expect(body.profiles.openrouter).toMatchObject({
    id: "openrouter",
    signupUrl: "https://openrouter.ai/keys",
    recommendation: {
      level: "recommended",
      rank: 60,
      cta: {
        kind: "external",
        label: "Create OpenRouter API key",
        url: "https://openrouter.ai/keys",
      },
    },
  })
  expect(body.connections[CodexProvider.PROVIDER_ID]).toMatchObject({
    id: CodexProvider.PROVIDER_ID,
    profileID: CodexProvider.PROVIDER_ID,
    catalogProviderID: CodexProvider.PROVIDER_ID,
    removable: false,
  })
})

test("provider connection routes manage a second account without changing its canonical provider", async () => {
  const before = await Config.domainGet("providers")
  const providerID = `deepseek-team-${Math.random().toString(36).slice(2)}`
  const standaloneID = `standalone-${Math.random().toString(36).slice(2)}`
  const app = Server.App()

  try {
    const createdResponse = await app.request("/provider/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: providerID,
        profileID: "deepseek",
        name: "DeepSeek Team",
        endpoint: "https://deepseek-team.invalid/v1",
        enabled: false,
      }),
    })
    const createdBody = await createdResponse.json()
    expect({ status: createdResponse.status, body: createdBody }).toEqual({
      status: 200,
      body: {
        id: providerID,
        name: "DeepSeek Team",
        profileID: "deepseek",
        catalogProviderID: "deepseek",
        endpoint: "https://deepseek-team.invalid/v1",
        enabled: false,
        configured: true,
        removable: true,
        canCreateSibling: true,
      },
    })

    const configured = await Config.domainGet("providers")
    await Config.domainUpdate(
      "providers",
      {
        ...configured,
        provider: {
          ...configured.provider,
          [providerID]: {
            ...configured.provider?.[providerID],
            whitelist: ["deepseek-chat"],
            options: {
              baseURL: "https://stale-deepseek-team.invalid/v1",
            },
          },
          [standaloneID]: {
            name: "Standalone Custom",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: {},
          },
        },
      },
      { mode: "replace-domain" },
    )

    const listedResponse = await app.request("/provider")
    const listed = await listedResponse.json()
    expect(listed.connections[providerID]).toMatchObject({
      profileID: "deepseek",
      enabled: false,
      removable: true,
    })
    expect(listed.connections[standaloneID]).toMatchObject({
      id: standaloneID,
      configured: true,
      removable: false,
      canCreateSibling: false,
    })
    expect(listed.runtimeAvailability[providerID]).toMatchObject({
      available: false,
      reason: "disabled",
      modelCount: 1,
    })
    expect(listed.all.some((provider: Provider.Info) => provider.id === providerID)).toBe(true)

    const updatedResponse = await app.request(`/provider/connections/${providerID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "DeepSeek Production",
        endpoint: null,
        enabled: true,
      }),
    })
    expect(updatedResponse.status).toBe(200)
    expect(await updatedResponse.json()).toMatchObject({
      id: providerID,
      name: "DeepSeek Production",
      enabled: true,
    })
    expect((await Config.domainGet("providers")).provider?.[providerID]).toMatchObject({
      modelsDevProviderID: "deepseek",
      name: "DeepSeek Production",
    })
    expect((await Config.domainGet("providers")).provider?.[providerID]?.api).toBeUndefined()
    expect((await Config.domainGet("providers")).provider?.[providerID]?.options?.baseURL).toBeUndefined()

    const enabledDomain = await Config.domainGet("providers")
    await Config.domainUpdate(
      "providers",
      {
        ...enabledDomain,
        enabled_providers: [providerID],
        disabled_providers: (enabledDomain.disabled_providers ?? []).filter((id) => id !== providerID),
      },
      { mode: "replace-domain" },
    )
    const disabledResponse = await app.request(`/provider/connections/${providerID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    expect(disabledResponse.status).toBe(200)
    expect(await Config.domainGet("providers")).toMatchObject({
      enabled_providers: [providerID],
      disabled_providers: expect.arrayContaining([providerID]),
    })

    await Auth.set("deepseek", { type: "api", key: "canonical-connection-test-key" })
    await Auth.set(providerID, { type: "api", key: "connection-test-key" })
    const removedResponse = await app.request(`/provider/connections/${providerID}`, { method: "DELETE" })
    expect(removedResponse.status).toBe(200)
    expect(await removedResponse.json()).toEqual({ providerID, removed: true })
    expect((await Config.domainGet("providers")).provider?.[providerID]).toBeUndefined()
    expect(await Auth.get(providerID)).toBeUndefined()
    expect(await Auth.get("deepseek")).toMatchObject({ type: "api", key: "canonical-connection-test-key" })

    const collisionResponse = await app.request("/provider/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "deepseek",
        profileID: "deepseek",
        name: "Canonical collision",
      }),
    })
    expect(collisionResponse.status).toBe(400)
    expect(await collisionResponse.json()).toMatchObject({
      name: "ProviderConnectionAlreadyExistsError",
      data: { providerID: "deepseek" },
    })
  } finally {
    await Auth.remove(providerID)
    await Auth.remove("deepseek")
    await Config.domainUpdate("providers", before, { mode: "replace-domain" })
    await Provider.reload()
  }
})

test("/provider keeps catalog providers visible when a runtime whitelist excludes them", async () => {
  await using tmp = await tmpdir({
    config: {
      enabled_providers: ["openai"],
      provider: {
        "existing-custom": {
          name: "Existing Custom",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          options: { apiKey: "test-key" },
          models: {
            model: {
              name: "Existing Model",
              limit: { context: 4000, output: 1000 },
            },
          },
        },
      },
    },
  })
  const response = await Server.App().request(`/provider?directory=${encodeURIComponent(tmp.path)}`)
  expect(response.status).toBe(200)
  const body = await response.json()

  expect(body.connected).toContain("openai")
  expect(body.connected).not.toContain(CodexProvider.PROVIDER_ID)
  expect(body.all.some((provider: Provider.Info) => provider.id === CodexProvider.PROVIDER_ID)).toBe(true)
  expect(body.catalogProviders).toContain(CodexProvider.PROVIDER_ID)
  expect(body.runtimeAvailability[CodexProvider.PROVIDER_ID]).toMatchObject({
    providerID: CodexProvider.PROVIDER_ID,
    available: false,
    reason: "disabled",
  })
  expect(body.connected).not.toContain("existing-custom")
  const existingCustom = body.all.find((provider: Provider.Info) => provider.id === "existing-custom")
  expect(existingCustom).toBeDefined()
  expect(existingCustom.options).toEqual({})
  expect(existingCustom.models.model.options).toEqual({})
  expect(existingCustom.models.model.headers).toEqual({})
  expect(existingCustom.models.model.variants).toEqual({})
  expect(JSON.stringify(existingCustom)).not.toContain("test-key")
  expect(body.configProviders).toContain("existing-custom")
  expect(body.connections["existing-custom"]).toBeUndefined()
  expect(body.runtimeAvailability["existing-custom"]).toMatchObject({
    providerID: "existing-custom",
    available: false,
    reason: "disabled",
  })
})

test("DELETE /provider/:providerID/auth refuses to clear healthy stored credentials", async () => {
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: accessToken(),
    refresh: "healthy-refresh",
    expires: nowSeconds() + 3600,
  })

  const app = Server.App()
  const beforeResponse = await app.request("/provider")
  const before = await beforeResponse.json()
  expect(before.authHealth[CodexProvider.PROVIDER_ID]).toMatchObject({
    status: "connected",
    canDisconnect: false,
  })

  const response = await app.request(`/provider/${CodexProvider.PROVIDER_ID}/auth`, { method: "DELETE" })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    name: "ProviderAuthDisconnectUnavailableError",
    data: {
      providerID: CodexProvider.PROVIDER_ID,
      status: "connected",
    },
  })
  expect((await Auth.entries())[CodexProvider.PROVIDER_ID]).toBeDefined()
})

test("DELETE /provider/:providerID/auth clears stored credentials without removing the provider", async () => {
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: accessToken(),
    refresh: "revoked-refresh",
    expires: nowSeconds() + 3600,
  })
  await Auth.markDead(CodexProvider.PROVIDER_ID, "credential_rejected")

  const app = Server.App()
  const beforeResponse = await app.request("/provider")
  const before = await beforeResponse.json()
  expect(before.authHealth[CodexProvider.PROVIDER_ID]).toMatchObject({
    status: "action_required",
    recovery: "reconnect",
    canDisconnect: true,
  })

  const response = await app.request(`/provider/${CodexProvider.PROVIDER_ID}/auth`, { method: "DELETE" })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ providerID: CodexProvider.PROVIDER_ID, cleared: true })
  expect((await Auth.entries())[CodexProvider.PROVIDER_ID]).toBeUndefined()

  const afterResponse = await app.request("/provider")
  const after = await afterResponse.json()
  expect(after.all.some((provider: Provider.Info) => provider.id === CodexProvider.PROVIDER_ID)).toBe(true)
  expect(after.catalogProviders).toContain(CodexProvider.PROVIDER_ID)
  expect(after.connected).not.toContain(CodexProvider.PROVIDER_ID)
  expect(after.authHealth[CodexProvider.PROVIDER_ID]).toMatchObject({
    status: "not_configured",
    canDisconnect: false,
  })

  const repeated = await app.request(`/provider/${CodexProvider.PROVIDER_ID}/auth`, { method: "DELETE" })
  expect(repeated.status).toBe(200)
  expect(await repeated.json()).toEqual({ providerID: CodexProvider.PROVIDER_ID, cleared: true })
})

test("POST /provider/:providerID/models/refresh uses the shared catalog refresh path", async () => {
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: accessToken(),
    refresh: "refresh-models",
    expires: nowSeconds() + 3600,
  })
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ models: [{ slug: "gpt-5.6-sol", priority: 1 }] }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch

  const response = await Server.App().request(`/provider/${CodexProvider.PROVIDER_ID}/models/refresh`, {
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ source: "live", refreshing: false, modelCount: 1 })
})

test("/provider returns runtime provider models with reasoning effort capabilities", async () => {
  const response = await Server.App().request("/provider")
  expect(response.status).toBe(200)
  const body = await response.json()
  const openAI = body.all.find((provider: Provider.Info) => provider.id === "openai")
  const model = openAI?.models["gpt-5.4-pro"]

  expect(model?.capabilities.reasoningEfforts).toEqual(["medium", "high", "xhigh"])
  expect(model?.reasoning_options).toBeUndefined()
})

test("usage rejection completes the durable auth-health transition before responding", async () => {
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: accessToken(),
    refresh: "revoked-refresh",
    expires: nowSeconds() + 3600,
  })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === CodexProvider.OAUTH_TOKEN_URL) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ error: { code: "token_invalidated" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  const app = Server.App()
  const usageResponse = await app.request(`/provider/${CodexProvider.PROVIDER_ID}/usage?scopeID=home`)
  expect(usageResponse.status).toBe(200)
  expect(await usageResponse.json()).toMatchObject({ status: "error", reloginRequired: true })

  const providerResponse = await app.request("/provider")
  const providers = await providerResponse.json()
  expect(providers.authHealth[CodexProvider.PROVIDER_ID]).toMatchObject({
    status: "action_required",
    recovery: "reconnect",
  })
})

test("/provider returns custom providers without recommendation metadata", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://example.test/v1",
              env: [],
              options: { apiKey: "test-key" },
              models: {
                model: {
                  name: "Custom Model",
                  limit: { context: 4000, output: 1000 },
                },
              },
            },
          },
        }),
      )
    },
  })

  const app = Server.App()
  const response = await app.request(`/provider?directory=${encodeURIComponent(tmp.path)}`)
  expect(response.status).toBe(200)
  const body = await response.json()

  expect(body.all.some((provider: any) => provider.id === "custom-provider")).toBe(true)
  expect(body.profiles["custom-provider"]).toMatchObject({
    id: "custom-provider",
    name: "Custom Provider",
  })
  expect(body.profiles["custom-provider"].recommendation).toBeUndefined()
})

test("/provider/auth exposes built-in OAuth and alternate credential methods", async () => {
  const app = Server.App()
  const response = await app.request("/provider/auth")
  expect(response.status).toBe(200)
  const body = await response.json()

  expect(body[CodexProvider.PROVIDER_ID]).toEqual([
    { type: "oauth", label: "Login with ChatGPT" },
    { type: "import", label: "Import Codex CLI credentials" },
  ])
  expect(body[CopilotProvider.PROVIDER_ID]).toEqual([
    { type: "oauth", label: "Login with GitHub Copilot" },
    { type: "api", label: "GitHub token" },
  ])
  expect(body[CopilotProvider.ENTERPRISE_PROVIDER_ID]).toEqual([
    { type: "oauth", label: "Login with GitHub Copilot Enterprise" },
    { type: "api", label: "GitHub token" },
  ])
})

test("/provider/:providerID/import imports local Codex CLI credentials", async () => {
  const token = accessToken()
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: token,
            refresh_token: "refresh-provider-route",
          },
        }),
      )
    },
  })
  process.env.CODEX_HOME = tmp.path

  const app = Server.App()
  const response = await app.request(`/provider/${CodexProvider.PROVIDER_ID}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: 1 }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toBe(true)
  expect(await Auth.get(CodexProvider.PROVIDER_ID)).toMatchObject({
    type: "oauth",
    access: token,
    refresh: "refresh-provider-route",
  })
})

test("/provider/:providerID/usage returns typed unavailable when disconnected", async () => {
  const app = Server.App()
  const response = await app.request(`/provider/${CodexProvider.PROVIDER_ID}/usage`)
  expect(response.status).toBe(200)
  const body = await response.json()

  expect(body).toMatchObject({
    providerID: CodexProvider.PROVIDER_ID,
    status: "unavailable",
    reloginRequired: true,
  })
})
