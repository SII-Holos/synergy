import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "path"
import { Auth } from "../../src/provider/api-key"
import { ProviderAuth } from "../../src/provider/auth"
import { CodexProvider } from "../../src/provider/codex"
import { ModelsDev } from "../../src/provider/models"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const originalFetch = globalThis.fetch

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function makeJWT(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.signature`
}

function accessToken(input?: { exp?: number; accountID?: string }) {
  return makeJWT({
    exp: input?.exp ?? nowSeconds() + 60 * 60,
    "https://api.openai.com/auth": {
      chatgpt_account_id: input?.accountID ?? "acct_test",
    },
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

async function resetCodexState() {
  globalThis.fetch = originalFetch
  delete process.env.SYNERGY_CODEX_BASE_URL
  await Auth.remove(CodexProvider.PROVIDER_ID)
  await Provider.reload()
}

beforeEach(resetCodexState)
afterEach(resetCodexState)

test("parses ChatGPT account id from access token claims", () => {
  const token = accessToken({ accountID: "acct_123" })

  expect(CodexProvider.chatGPTAccountID(token)).toBe("acct_123")
  expect(CodexProvider.chatGPTAccountID("not-a-jwt")).toBeUndefined()
  expect(CodexProvider.codexHeaders(token)["ChatGPT-Account-ID"]).toBe("acct_123")
})

test("device-code flow exchanges authorization code for OAuth tokens", async () => {
  const issuedAccess = accessToken()
  const calls: string[] = []
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      expect(init?.method).toBe("POST")
      return jsonResponse({ user_code: "ABCD-EFGH", device_auth_id: "device-1", interval: 1 })
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({ device_auth_id: "device-1", user_code: "ABCD-EFGH" })
      return jsonResponse({ authorization_code: "auth-code", code_verifier: "verifier" })
    }
    if (url.endsWith("/oauth/token")) {
      const body = init?.body as URLSearchParams
      expect(body.get("grant_type")).toBe("authorization_code")
      expect(body.get("code")).toBe("auth-code")
      expect(body.get("code_verifier")).toBe("verifier")
      return jsonResponse({ access_token: issuedAccess, refresh_token: "refresh-1", expires_in: 3600 })
    }
    throw new Error(`unexpected URL ${url}`)
  }

  const device = await CodexProvider.requestDeviceCode(fetchFn)
  expect(device).toEqual({ userCode: "ABCD-EFGH", deviceAuthID: "device-1", intervalSeconds: 3 })

  const token = await CodexProvider.pollDeviceCode({ ...device, intervalSeconds: 0 }, fetchFn)

  expect(token.access).toBe(issuedAccess)
  expect(token.refresh).toBe("refresh-1")
  expect(calls).toEqual([
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/api/accounts/deviceauth/token",
    "https://auth.openai.com/oauth/token",
  ])
})

test("resolveToken returns fresh access token without refreshing", async () => {
  const token = accessToken({ exp: nowSeconds() + 60 * 60 })
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: token,
    refresh: "refresh-existing",
    expires: nowSeconds() + 60 * 60,
  })

  let refreshCalls = 0
  const resolved = await CodexProvider.resolveToken({
    fetch: async () => {
      refreshCalls++
      return jsonResponse({})
    },
  })

  expect(resolved).toBe(token)
  expect(refreshCalls).toBe(0)
})

test("resolveToken refreshes expiring access token and persists rotated refresh token", async () => {
  const oldToken = accessToken({ exp: nowSeconds() + 30 })
  const newToken = accessToken({ exp: nowSeconds() + 60 * 60, accountID: "acct_new" })
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: oldToken,
    refresh: "refresh-old",
    expires: nowSeconds() + 30,
  })

  const resolved = await CodexProvider.resolveToken({
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token")
      const body = init?.body as URLSearchParams
      expect(body.get("grant_type")).toBe("refresh_token")
      expect(body.get("refresh_token")).toBe("refresh-old")
      return jsonResponse({ access_token: newToken, refresh_token: "refresh-new", expires_in: 3600 })
    },
  })

  const stored = await Auth.get(CodexProvider.PROVIDER_ID)
  expect(resolved).toBe(newToken)
  expect(stored?.type).toBe("oauth")
  if (stored?.type === "oauth") {
    expect(stored.access).toBe(newToken)
    expect(stored.refresh).toBe("refresh-new")
  }
})

test("resolveToken keeps current token on refresh rate limit but requires relogin on invalid grant", async () => {
  const staleToken = accessToken({ exp: nowSeconds() - 30 })
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: staleToken,
    refresh: "refresh-old",
    expires: nowSeconds() - 30,
  })

  const rateLimited = await CodexProvider.resolveToken({
    fetch: async () => jsonResponse({ error: "rate_limited" }, { status: 429 }),
  })
  expect(rateLimited).toBe(staleToken)

  let thrown: unknown
  try {
    await CodexProvider.resolveToken({
      fetch: async () =>
        jsonResponse({ error: "invalid_grant", error_description: "refresh token reused" }, { status: 400 }),
    })
  } catch (error) {
    thrown = error
  }

  expect(CodexProvider.AuthError.isInstance(thrown)).toBe(true)
  if (CodexProvider.AuthError.isInstance(thrown)) {
    expect(thrown.data.reloginRequired).toBe(true)
  }
})

test("imports valid Codex CLI auth without sharing the auth file", async () => {
  const token = accessToken({ exp: nowSeconds() + 60 * 60 })
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: token,
            refresh_token: "refresh-cli",
          },
        }),
      )
    },
  })

  const imported = await CodexProvider.importCodexCliAuth({ codexHome: tmp.path })
  expect(imported).toEqual({
    access: token,
    refresh: "refresh-cli",
    expires: CodexProvider.accessTokenExpiresAt(token)!,
  })

  await Bun.write(path.join(tmp.path, "auth.json"), "{bad json")
  expect(await CodexProvider.importCodexCliAuth({ codexHome: tmp.path })).toBeUndefined()
})

test("codexFetch rewrites authorization, Codex headers, session headers, and request body", async () => {
  const token = accessToken({ accountID: "acct_fetch" })
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: token,
    refresh: "refresh-fetch",
    expires: nowSeconds() + 60 * 60,
  })

  let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
  globalThis.fetch = asFetch(async (input, init) => {
    captured = { input, init }
    return jsonResponse({ ok: true })
  })

  await CodexProvider.codexFetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer stale",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      input: "hello",
      prompt_cache_key: "session-1",
      max_output_tokens: 123,
    }),
  })

  expect(captured?.input).toBe("https://chatgpt.com/backend-api/codex/responses")
  const headers = new Headers(captured?.init?.headers)
  expect(headers.get("authorization")).toBe(`Bearer ${token}`)
  expect(headers.get("originator")).toBe("codex_cli_rs")
  expect(headers.get("user-agent")).toContain("codex_cli_rs")
  expect(headers.get("chatgpt-account-id")).toBe("acct_fetch")
  expect(headers.get("session_id")).toBe("session-1")
  expect(headers.get("x-client-request-id")).toBe("session-1")

  const body = JSON.parse(String(captured?.init?.body))
  expect(body.prompt_cache_key).toBe("session-1")
  expect(body.max_output_tokens).toBeUndefined()
})

test("fetchModelIDs sorts visible Codex models and sends Codex headers", async () => {
  const token = accessToken({ accountID: "acct_models" })
  const ids = await CodexProvider.fetchModelIDs(token, async (input, init) => {
    expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${token}`)
    expect(headers.get("originator")).toBe("codex_cli_rs")
    expect(headers.get("chatgpt-account-id")).toBe("acct_models")
    return jsonResponse({
      models: [
        { slug: "gpt-5.5", priority: 20 },
        { slug: "gpt-5.4-mini", priority: 10 },
        { slug: "hidden-model", visibility: "hidden", priority: 1 },
      ],
    })
  })

  expect(ids).toEqual(["gpt-5.4-mini", "gpt-5.5"])
})

test("models.dev catalog includes OpenAI Codex before login", async () => {
  const catalog = await ModelsDev.get()
  const codex = catalog[CodexProvider.PROVIDER_ID]

  expect(codex).toBeDefined()
  expect(codex.name).toBe("OpenAI Codex")
  expect(codex.models["gpt-5.4-mini"]).toBeDefined()
  expect(codex.models["gpt-5.4-mini"].provider?.npm).toBe("@ai-sdk/openai")
})

test("provider auth registry exposes built-in Codex OAuth method", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      const methods = await ProviderAuth.methods()
      expect(methods[CodexProvider.PROVIDER_ID]).toEqual([
        {
          type: "oauth",
          label: "Login with ChatGPT",
        },
      ])
    },
  })
})

test("logged-in Codex provider loads account-visible models and respects provider filters", async () => {
  const token = accessToken({ exp: nowSeconds() + 60 * 60 })
  await Auth.set(CodexProvider.PROVIDER_ID, {
    type: "oauth",
    access: token,
    refresh: "refresh-provider",
    expires: nowSeconds() + 60 * 60,
  })
  globalThis.fetch = asFetch(async () =>
    jsonResponse({
      models: [{ slug: "gpt-5.4-mini", priority: 1 }],
    }),
  )

  await using allowed = await tmpdir()
  await ScopeContext.provide({
    scope: await allowed.scope(),
    async fn() {
      await Provider.reload()
      const providers = await Provider.list()
      expect(providers[CodexProvider.PROVIDER_ID]).toBeDefined()
      expect(Object.keys(providers[CodexProvider.PROVIDER_ID].models)).toEqual(["gpt-5.4-mini"])
    },
  })

  await using filtered = await tmpdir({
    config: {
      enabled_providers: ["anthropic"],
    },
  })
  await ScopeContext.provide({
    scope: await filtered.scope(),
    async fn() {
      await Provider.reload()
      const providers = await Provider.list()
      expect(providers[CodexProvider.PROVIDER_ID]).toBeUndefined()
    },
  })
})
