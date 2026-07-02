import { afterEach, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { Auth } from "../../src/provider/api-key"
import { AnthropicOAuthProvider } from "../../src/provider/anthropic-oauth"
import { ProviderCatalog } from "../../src/provider/catalog"
import { CodexProvider } from "../../src/provider/codex"
import { AccountUsage } from "../../src/provider/usage"
import { ProviderProfile } from "../../src/provider/profile"
import { Plugin } from "../../src/plugin"

const originalFetch = globalThis.fetch
const originalProviderCatalogFetchDisabled = process.env.SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH
const originalPluginAllHooks = Plugin.allHooks

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
    "https://api.openai.com/auth.chatgpt_account_id": "acct_usage",
  })
}

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  })
}

function asFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return fn as unknown as typeof fetch
}

async function cleanupAuth() {
  for (const provider of ["openai-codex", "anthropic", "openrouter"]) {
    await Auth.remove(provider).catch(() => {})
  }
  await fs.rm(Global.Path.authApiKey, { force: true }).catch(() => {})
  await fs.rm(`${Global.Path.authApiKey}.bak`, { force: true }).catch(() => {})
  await fs.rm(Global.Path.providerCatalogCache, { force: true }).catch(() => {})
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalProviderCatalogFetchDisabled === undefined) {
    delete process.env.SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH
  } else {
    process.env.SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH = originalProviderCatalogFetchDisabled
  }
  ;(Plugin as any).allHooks = originalPluginAllHooks
  ProviderCatalog.reset()
  await cleanupAuth()
})

async function signedCatalog(catalog: unknown) {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const text = JSON.stringify(catalog)
  const signature = Buffer.from(
    await crypto.subtle.sign({ name: "Ed25519" } as any, keyPair.privateKey, new TextEncoder().encode(text)),
  ).toString("base64")
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey)).toString("base64")
  return { text, signature, publicKey }
}

function remoteCatalogFetch(url: string, text: string, signature: string) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const target = String(input)
    if (target === url) return new Response(text)
    if (target === `${url}.sig`) return new Response(signature)
    return new Response("not found", { status: 404 })
  }) as typeof fetch
}

test("provider catalog supplies subscription providers missing from models.dev", async () => {
  const catalog = await ProviderCatalog.resolve({
    forceRefresh: true,
    config: { providerCatalog: { enabled: false, offlineCache: false } },
  })

  expect(catalog["openai-codex"]).toBeDefined()
  expect(catalog["openai-codex"].models["gpt-5.4-mini"]).toBeDefined()
  expect(catalog["minimax-oauth"]).toBeDefined()
  expect(catalog["qwen-oauth"]).toBeDefined()
  expect(catalog["github-copilot"]).toBeDefined()
})

test("provider catalog exposes bundled profile aliases", async () => {
  await ProviderCatalog.resolve({
    forceRefresh: true,
    config: { providerCatalog: { enabled: false, offlineCache: false } },
  })

  expect(ProviderProfile.canonicalID("copilot")).toBe("github-copilot")
  expect(ProviderProfile.canonicalID("github-models")).toBe("github-copilot")
})

test("provider catalog merges signed remote providers with models.dev metadata mapping", async () => {
  delete process.env.SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH
  const registryUrl = "https://registry.test/catalog.v1.json"
  const remote = {
    version: 1,
    providers: {
      "remote-codex": {
        id: "remote-codex",
        name: "Remote Codex",
        description: "Remote provider description",
        signupUrl: "https://remote.test/signup",
        recommendation: {
          level: "recommended",
          rank: 42,
          headline: "Remote Recommended",
          reason: "Remote provider reason",
          cta: {
            kind: "external",
            label: "Create remote key",
            url: "https://remote.test/keys",
          },
          defaultModel: "remote-only-model",
        },
        modelsDevProviderID: "openai",
        authStrategy: "codex-chatgpt-oauth",
        fallbackModels: ["gpt-4.1-nano", "remote-only-model"],
      },
    },
  }
  const signed = await signedCatalog(remote)
  remoteCatalogFetch(registryUrl, signed.text, signed.signature)

  const catalog = await ProviderCatalog.resolve({
    forceRefresh: true,
    config: {
      providerCatalog: {
        enabled: true,
        registryUrl,
        publicKey: signed.publicKey,
        offlineCache: false,
      },
    },
  })

  expect(catalog["remote-codex"].models["gpt-4.1-nano"].name).toBe("GPT-4.1 nano")
  expect(catalog["remote-codex"].models["gpt-4.1-nano"].provider?.npm).toBe("@ai-sdk/openai")
  expect(catalog["remote-codex"].models["remote-only-model"]).toBeDefined()
  expect(ProviderCatalog.providerMetadata(catalog["remote-codex"])).toMatchObject({
    id: "remote-codex",
    name: "Remote Codex",
    description: "Remote provider description",
    signupUrl: "https://remote.test/signup",
    recommendation: {
      level: "recommended",
      rank: 42,
      headline: "Remote Recommended",
      reason: "Remote provider reason",
      cta: {
        kind: "external",
        label: "Create remote key",
        url: "https://remote.test/keys",
      },
      defaultModel: "remote-only-model",
    },
  })
})

test("provider catalog exposes plugin provider recommendation metadata", async () => {
  ;(Plugin as any).allHooks = mock(async () => [
    {
      provider: {
        id: "plugin-recommended-provider",
        name: "Plugin Recommended",
        description: "Plugin provider description",
        signupUrl: "https://plugin.test/signup",
        baseURL: "https://plugin.test/v1",
        authKind: "api_key",
        aiSdkPackage: "@ai-sdk/openai-compatible",
        fallbackModels: ["plugin-model"],
        recommendation: {
          level: "featured",
          rank: 7,
          headline: "Plugin Featured",
          reason: "Plugin provider reason",
          cta: {
            kind: "external",
            label: "Create plugin key",
            url: "https://plugin.test/keys",
          },
          defaultModel: "plugin-model",
        },
      },
    },
  ])
  ProviderCatalog.reset()

  const catalog = await ProviderCatalog.resolve({
    forceRefresh: true,
    config: { providerCatalog: { enabled: false, offlineCache: false } },
  })

  expect(catalog["plugin-recommended-provider"].models["plugin-model"]).toBeDefined()
  expect(ProviderCatalog.providerMetadata(catalog["plugin-recommended-provider"])).toMatchObject({
    id: "plugin-recommended-provider",
    name: "Plugin Recommended",
    description: "Plugin provider description",
    signupUrl: "https://plugin.test/signup",
    recommendation: {
      level: "featured",
      rank: 7,
      headline: "Plugin Featured",
      reason: "Plugin provider reason",
      cta: {
        kind: "external",
        label: "Create plugin key",
        url: "https://plugin.test/keys",
      },
      defaultModel: "plugin-model",
    },
  })
})

test("provider catalog live discovery supports model catalog metadata and legacy model ids", async () => {
  ;(Plugin as any).allHooks = mock(async () => [
    {
      provider: [
        {
          id: "plugin-live-catalog-provider",
          name: "Plugin Live Catalog",
          authKind: "none",
          aiSdkPackage: "@ai-sdk/openai-compatible",
          fallbackModels: ["static-model"],
          fetchModelCatalog: async () => [
            {
              id: "catalog-model",
              model: {
                limit: { context: 12_345, input: 12_345, output: 321 },
              },
            },
          ],
        },
        {
          id: "plugin-live-ids-provider",
          name: "Plugin Live IDs",
          authKind: "none",
          aiSdkPackage: "@ai-sdk/openai-compatible",
          fallbackModels: ["static-model"],
          fetchModels: async () => ["legacy-model"],
        },
      ],
    },
  ])
  ProviderCatalog.reset()

  const catalog = await ProviderCatalog.resolve({
    forceRefresh: true,
    includeLive: true,
    config: { providerCatalog: { enabled: false, offlineCache: false } },
  })

  expect(Object.keys(catalog["plugin-live-catalog-provider"].models)).toEqual(["catalog-model"])
  expect(catalog["plugin-live-catalog-provider"].models["catalog-model"].limit).toEqual({
    context: 12_345,
    input: 12_345,
    output: 321,
  })
  expect(Object.keys(catalog["plugin-live-ids-provider"].models)).toEqual(["legacy-model"])
  expect(catalog["plugin-live-ids-provider"].models["legacy-model"].limit.context).toBe(128_000)
})

test("provider catalog rejects bad signatures and falls back to last verified cache", async () => {
  delete process.env.SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH
  const registryUrl = "https://registry.test/catalog.v1.json"
  const remote = {
    version: 1,
    providers: {
      "cached-provider": {
        id: "cached-provider",
        name: "Cached Provider",
        fallbackModels: ["cached-model"],
      },
    },
  }
  const signed = await signedCatalog(remote)
  remoteCatalogFetch(registryUrl, signed.text, signed.signature)

  const verified = await ProviderCatalog.resolve({
    forceRefresh: true,
    config: {
      providerCatalog: {
        enabled: true,
        registryUrl,
        publicKey: signed.publicKey,
        offlineCache: true,
      },
    },
  })
  expect(verified["cached-provider"].models["cached-model"]).toBeDefined()

  ProviderCatalog.reset()
  const tampered = {
    version: 1,
    providers: {
      "tampered-provider": {
        id: "tampered-provider",
        name: "Tampered Provider",
        fallbackModels: ["tampered-model"],
      },
    },
  }
  remoteCatalogFetch(registryUrl, JSON.stringify(tampered), "not-a-valid-signature")

  const fallback = await ProviderCatalog.resolve({
    forceRefresh: true,
    config: {
      providerCatalog: {
        enabled: true,
        registryUrl,
        publicKey: signed.publicKey,
        offlineCache: true,
      },
    },
  })

  expect(fallback["cached-provider"].models["cached-model"]).toBeDefined()
  expect(fallback["tampered-provider"]).toBeUndefined()
})

test("provider catalog ignores unsigned remote providers when no verified cache exists", async () => {
  delete process.env.SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH
  const registryUrl = "https://registry.test/catalog.v1.json"
  remoteCatalogFetch(
    registryUrl,
    JSON.stringify({
      version: 1,
      providers: {
        "unsigned-provider": {
          id: "unsigned-provider",
          name: "Unsigned Provider",
          fallbackModels: ["unsigned-model"],
        },
      },
    }),
    "bad-signature",
  )

  const catalog = await ProviderCatalog.resolve({
    forceRefresh: true,
    config: {
      providerCatalog: {
        enabled: true,
        registryUrl,
        publicKey: ProviderCatalog.DEFAULT_PUBLIC_KEY,
        offlineCache: true,
      },
    },
  })

  expect(catalog["unsigned-provider"]).toBeUndefined()
})

test("provider auth store migrates legacy api-key.json into v2 store", async () => {
  await cleanupAuth()
  await Bun.write(
    Global.Path.authApiKey,
    JSON.stringify({
      anthropic: { type: "api", key: "sk-ant-test" },
      "openai-codex": {
        type: "oauth",
        access: accessToken(),
        refresh: "refresh-test",
        expires: nowSeconds() + 3600,
      },
    }),
  )
  await fs.chmod(Global.Path.authApiKey, 0o600)

  const result = await Auth.migrateLegacy()
  const all = await Auth.all()
  const stat = await fs.stat(Global.Path.authProvider)

  expect(result).toEqual({ migrated: true, count: 2 })
  expect(all.anthropic).toEqual({ type: "api", key: "sk-ant-test" })
  expect(all["openai-codex"]?.type).toBe("oauth")
  if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600)
  expect(await Bun.file(`${Global.Path.authApiKey}.bak`).exists()).toBe(true)

  const raw = await Bun.file(Global.Path.authProvider).json()
  expect(raw.schemaVersion).toBe(2)
  expect(raw.credentials.anthropic.auth).toBeUndefined()
  expect(raw.credentials.anthropic.authKind).toBe("api_key")
  expect(raw.credentials.anthropic.tokens.apiKey).toBe("sk-ant-test")
  expect(raw.credentials["openai-codex"].tokens.accessToken).toBeDefined()
  expect(raw.credentials["openai-codex"].tokens.refreshToken).toBe("refresh-test")
  expect(raw.credentials["openai-codex"].expiresAt).toBeGreaterThan(nowSeconds())
})

test("provider auth runtime ignores legacy api-key.json without migration", async () => {
  await cleanupAuth()
  await Bun.write(
    Global.Path.authApiKey,
    JSON.stringify({
      "legacy-only": { type: "api", key: "sk-legacy" },
    }),
  )

  expect(await Auth.get("legacy-only")).toBeUndefined()
})

test("provider auth pool skips exhausted and dead credentials", async () => {
  await Auth.set("openrouter", { type: "api", key: "primary" })
  await Auth.addToPool("openrouter", "backup", { type: "api", key: "backup" })

  expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "primary" })

  await Auth.markExhausted("openrouter", {
    credentialID: "openrouter",
    failureCode: "rate_limited",
    cooldownUntil: nowSeconds() + 60,
  })
  expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "backup" })

  await Auth.markDead("openrouter", "invalid_grant", { credentialID: "backup" })
  expect(await Auth.get("openrouter")).toBeUndefined()

  await Auth.markExhausted("openrouter", {
    credentialID: "openrouter",
    failureCode: "rate_limited",
    cooldownUntil: nowSeconds() - 1,
  })
  expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "primary" })
})

test("codex usage parser returns session and weekly quota windows", async () => {
  await Auth.set("openai-codex", {
    type: "oauth",
    access: accessToken(),
    refresh: "refresh-test",
    expires: nowSeconds() + 3600,
  })

  const snapshot = await CodexProvider.fetchUsage(async (input, init) => {
    expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toContain("Bearer ")
    expect(headers.get("chatgpt-account-id")).toBe("acct_usage")
    return jsonResponse({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 25, reset_at: "2026-06-25T10:00:00Z" },
        secondary_window: { used_percent: 75, reset_at: "2026-06-29T10:00:00Z" },
      },
      credits: { has_credits: true, balance: 12.5 },
    })
  })

  expect(snapshot.status).toBe("available")
  expect(snapshot.windows.map((window) => [window.label, window.usedPercent, window.remainingPercent])).toEqual([
    ["Session", 25, 75],
    ["Weekly", 75, 25],
  ])
  expect(snapshot.details).toContain("Credits balance: $12.50")
})

test("anthropic oauth usage parser returns claude quota windows", async () => {
  await Auth.set("anthropic", {
    type: "oauth",
    access: "anthropic-access",
    refresh: "anthropic-refresh",
    expires: nowSeconds() + 3600,
  })

  const snapshot = await AnthropicOAuthProvider.fetchUsage(async (input, init) => {
    expect(String(input)).toBe("https://api.anthropic.com/api/oauth/usage")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer anthropic-access")
    return jsonResponse({
      five_hour: { utilization: 0.5, resets_at: "2026-06-25T10:00:00Z" },
      seven_day: { utilization: 80, resets_at: "2026-06-29T10:00:00Z" },
      extra_usage: { is_enabled: true, used_credits: 2, monthly_limit: 10, currency: "USD" },
    })
  })

  expect(snapshot.windows.map((window) => [window.label, window.usedPercent, window.remainingPercent])).toEqual([
    ["Current session", 50, 50],
    ["Current week", 80, 20],
  ])
  expect(snapshot.details).toContain("Extra usage: 2.00 / 10.00 USD")
})

test("openrouter usage parser returns credit balance", async () => {
  await Auth.set("openrouter", { type: "api", key: "sk-or-test" })

  const snapshot = await AccountUsage.openrouter(
    "openrouter",
    asFetch(async (input) => {
      if (String(input).endsWith("/credits")) {
        return jsonResponse({ data: { total_credits: 20, total_usage: 7.5 } })
      }
      return jsonResponse({ data: { limit: 10, limit_remaining: 4, usage: 6 } })
    }),
  )

  expect(snapshot.status).toBe("available")
  expect(snapshot.credits?.balance).toBe(12.5)
  expect(snapshot.credits?.currency).toBe("USD")
  expect(snapshot.details).toContain("Credits balance: $12.50")
  expect(snapshot.windows[0]?.usedPercent).toBe(60)
  expect(snapshot.windows[0]?.remainingPercent).toBe(40)
})
