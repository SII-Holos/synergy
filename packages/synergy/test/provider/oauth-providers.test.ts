import { afterEach, beforeEach, expect, test } from "bun:test"
import { Auth } from "../../src/provider/api-key"
import { AnthropicOAuthProvider } from "../../src/provider/anthropic-oauth"
import { CopilotProvider } from "../../src/provider/copilot"
import { MiniMaxProvider } from "../../src/provider/minimax"
import { GitHubProvider } from "../../src/provider/github"

const originalFetch = globalThis.fetch
const originalGHToken = process.env.GH_TOKEN
const originalGITHUBToken = process.env.GITHUB_TOKEN

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
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

async function reset() {
  globalThis.fetch = originalFetch
  for (const provider of [
    AnthropicOAuthProvider.PROVIDER_ID,
    CopilotProvider.PROVIDER_ID,
    CopilotProvider.ENTERPRISE_PROVIDER_ID,
    MiniMaxProvider.PROVIDER_ID,
  ]) {
    await Auth.remove(provider).catch(() => {})
  }
  if (originalGHToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalGHToken
  if (originalGITHUBToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGITHUBToken
}

beforeEach(async () => {
  await reset()
})
afterEach(reset)

test("anthropic oauth code flow exchanges code and Claude Code fetch headers replace API-key auth", async () => {
  const authorize = await AnthropicOAuthProvider.authorizeOAuth(
    asFetch(async (input, init) => {
      expect(String(input)).toBe("https://platform.claude.com/v1/oauth/token")
      const body = JSON.parse(String(init?.body))
      expect(body.grant_type).toBe("authorization_code")
      expect(body.code).toBe("claude-code")
      expect(body.client_id).toBe(AnthropicOAuthProvider.OAUTH_CLIENT_ID)
      expect(new Headers(init?.headers).get("user-agent")).toContain("claude-cli")
      return jsonResponse({
        access_token: "anthropic-access",
        refresh_token: "anthropic-refresh",
        expires_in: 3600,
      })
    }),
  )
  const state = new URL(authorize.url).searchParams.get("state")
  const result = await authorize.callback(`claude-code#${state}`)
  expect(result.type).toBe("success")
  if (result.type !== "success" || !("refresh" in result)) throw new Error("expected oauth success")

  await Auth.set(AnthropicOAuthProvider.PROVIDER_ID, {
    type: "oauth",
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
  })

  globalThis.fetch = asFetch(async (_input, init) => {
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer anthropic-access")
    expect(headers.get("x-api-key")).toBeNull()
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
    expect(headers.get("x-app")).toBe("cli")
    return jsonResponse({ ok: true })
  })
  await AnthropicOAuthProvider.anthropicFetch("https://api.anthropic.com/v1/messages", {
    headers: {
      "x-api-key": "should-be-removed",
    },
  })
})

test("anthropic oauth refresh rotates tokens and marks invalid grants dead", async () => {
  await Auth.set(AnthropicOAuthProvider.PROVIDER_ID, {
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: nowSeconds() - 1,
  })

  const refreshed = await AnthropicOAuthProvider.resolveToken({
    fetch: asFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.grant_type).toBe("refresh_token")
      expect(body.refresh_token).toBe("old-refresh")
      return jsonResponse({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      })
    }),
  })
  expect(refreshed).toBe("new-access")
  expect(await Auth.get(AnthropicOAuthProvider.PROVIDER_ID)).toMatchObject({
    type: "oauth",
    access: "new-access",
    refresh: "new-refresh",
  })

  await Auth.set(AnthropicOAuthProvider.PROVIDER_ID, {
    type: "oauth",
    access: "bad-access",
    refresh: "bad-refresh",
    expires: nowSeconds() - 1,
  })
  await expect(
    AnthropicOAuthProvider.resolveToken({
      fetch: asFetch(async () => jsonResponse({ error: "invalid_grant" }, { status: 400 })),
    }),
  ).rejects.toThrow()
  expect(await Auth.get(AnthropicOAuthProvider.PROVIDER_ID)).toBeUndefined()
})

test("anthropic request rejection refreshes once and retries with the rotated token", async () => {
  await Auth.set(AnthropicOAuthProvider.PROVIDER_ID, {
    type: "oauth",
    access: "anthropic-old",
    refresh: "anthropic-refresh",
    expires: nowSeconds() + 3600,
  })
  let refreshes = 0
  let requests = 0
  globalThis.fetch = asFetch(async (input, init) => {
    if (AnthropicOAuthProvider.OAUTH_TOKEN_URLS.some((url) => url === String(input))) {
      refreshes++
      return jsonResponse({ access_token: "anthropic-new", refresh_token: "anthropic-refresh-2", expires_in: 3600 })
    }
    requests++
    const token = new Headers(init?.headers).get("authorization")
    return token === "Bearer anthropic-new"
      ? jsonResponse({ ok: true })
      : jsonResponse({ type: "authentication_error" }, { status: 401 })
  })

  const response = await AnthropicOAuthProvider.anthropicFetch("https://api.anthropic.com/v1/messages")
  expect(response.status).toBe(200)
  expect(refreshes).toBe(1)
  expect(requests).toBe(2)
})

test("github copilot device login exchanges a GitHub token for Copilot models", async () => {
  const authorize = await CopilotProvider.authorizeDeviceCode(
    CopilotProvider.PROVIDER_ID,
    asFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/login/device/code")) {
        expect(init?.method).toBe("POST")
        return jsonResponse({
          device_code: "device-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 300,
        })
      }
      if (url.endsWith("/login/oauth/access_token")) {
        const body = init?.body as URLSearchParams
        expect(body.get("device_code")).toBe("device-1")
        return jsonResponse({ access_token: "github-device-token" })
      }
      throw new Error(`unexpected URL ${url}`)
    }),
  )
  expect(authorize.instructions).toBe("ABCD-EFGH")
  expect(authorize.method).toBe("auto")
  if (authorize.method !== "auto") throw new Error("expected auto device flow")
  const login = await authorize.callback()
  expect(login).toEqual({
    type: "success",
    provider: CopilotProvider.PROVIDER_ID,
    key: "github-device-token",
  })

  await Auth.set(CopilotProvider.PROVIDER_ID, { type: "api", key: "github-device-token" })
  const models = await CopilotProvider.fetchModelIDs(
    CopilotProvider.PROVIDER_ID,
    asFetch(async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      if (url === CopilotProvider.TOKEN_EXCHANGE_URL) {
        expect(headers.get("authorization")).toBe("token github-device-token")
        expect(headers.get("editor-version")).toBe(CopilotProvider.EDITOR_VERSION)
        return jsonResponse({ token: "copilot-api-token", expires_at: nowSeconds() + 3600 })
      }
      if (url === `${CopilotProvider.BASE_URL}/models`) {
        expect(headers.get("authorization")).toBe("Bearer copilot-api-token")
        return jsonResponse({ data: [{ id: "gpt-5.4-mini" }, { id: "claude-sonnet-4.6" }] })
      }
      throw new Error(`unexpected URL ${url}`)
    }),
  )

  expect(models).toEqual(["gpt-5.4-mini", "claude-sonnet-4.6"])
})

test("github copilot model catalog preserves API vision capabilities", async () => {
  await Auth.set(CopilotProvider.PROVIDER_ID, { type: "api", key: "github-device-token" })
  const catalog = await CopilotProvider.fetchModelCatalog(
    CopilotProvider.PROVIDER_ID,
    asFetch(async (input) => {
      const url = String(input)
      if (url === CopilotProvider.TOKEN_EXCHANGE_URL) {
        return jsonResponse({ token: "copilot-api-token", expires_at: nowSeconds() + 3600 })
      }
      if (url === `${CopilotProvider.BASE_URL}/models`) {
        return jsonResponse({
          data: [
            {
              id: "vision-model",
              capabilities: {
                supports: { vision: true },
                limits: { vision: { supported_media_types: ["image/png", "image/jpeg"] } },
              },
            },
            { id: "text-model", capabilities: { supports: { vision: false } } },
          ],
        })
      }
      throw new Error(`unexpected URL ${url}`)
    }),
  )

  expect(catalog).toEqual([
    {
      id: "vision-model",
      model: { modalities: { input: ["text", "image"], output: ["text"] } },
    },
    {
      id: "text-model",
      model: { modalities: { input: ["text"], output: ["text"] } },
    },
  ])
})

test("github provider device login resolves managed token and reports account status", async () => {
  const authorize = await GitHubProvider.authorizeDeviceCode(
    asFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/login/device/code")) {
        const body = init?.body as URLSearchParams
        expect(body.get("client_id")).toBe(GitHubProvider.OAUTH_CLIENT_ID)
        expect(body.get("scope")).toBe(GitHubProvider.DEVICE_SCOPE)
        return jsonResponse({
          device_code: "device-github",
          user_code: "GH-CODE",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 300,
        })
      }
      if (url.endsWith("/login/oauth/access_token")) {
        const body = init?.body as URLSearchParams
        expect(body.get("client_id")).toBe(GitHubProvider.OAUTH_CLIENT_ID)
        expect(body.get("device_code")).toBe("device-github")
        return jsonResponse({ access_token: "github-managed-token" })
      }
      if (url === "https://api.github.com/user") {
        const headers = new Headers(init?.headers)
        expect(headers.get("authorization")).toBe("Bearer github-managed-token")
        return jsonResponse({ login: "octocat", id: 1, html_url: "https://github.com/octocat" })
      }
      throw new Error(`unexpected URL ${url}`)
    }),
  )
  expect(authorize.method).toBe("auto")
  if (authorize.method !== "auto") throw new Error("expected auto device flow")
  expect(authorize.instructions).toBe("GH-CODE")
  const login = await authorize.callback()
  expect(login.type).toBe("success")
  if (login.type !== "success" || !("key" in login)) throw new Error("expected api success")
  expect(login.key).toBe("github-managed-token")
  expect((login as any).metadata).toEqual({ account: { id: 1, login: "octocat", url: "https://github.com/octocat" } })

  await Auth.set(GitHubProvider.PROVIDER_ID, { type: "api", key: "github-managed-token" })
  const resolved = await GitHubProvider.resolveToken()
  expect(resolved).toMatchObject({
    token: "github-managed-token",
    source: "store",
    authKind: "api_key",
  })

  const status = await GitHubProvider.status(
    asFetch(async (_input, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer github-managed-token")
      return jsonResponse({ login: "octocat", id: 1, html_url: "https://github.com/octocat" })
    }),
  )
  expect(status).toMatchObject({
    providerID: GitHubProvider.PROVIDER_ID,
    status: "connected",
    source: "store",
    account: { login: "octocat" },
  })
})

test("github provider resolves GH_TOKEN before stored credentials", async () => {
  process.env.GH_TOKEN = "env-github-token"
  await Auth.set(GitHubProvider.PROVIDER_ID, { type: "api", key: "stored-github-token" })
  const resolved = await GitHubProvider.resolveToken()
  expect(resolved).toMatchObject({
    token: "env-github-token",
    source: "env",
  })
  delete process.env.GH_TOKEN
})

test("minimax user-code oauth refreshes short tokens and injects bearer auth", async () => {
  const authorize = await MiniMaxProvider.authorizeOAuth(
    asFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/oauth/code")) {
        const body = init?.body as URLSearchParams
        expect(body.get("client_id")).toBe(MiniMaxProvider.CLIENT_ID)
        return jsonResponse({
          state: body.get("state"),
          user_code: "MINIMAX-CODE",
          verification_uri: "https://api.minimax.io/oauth/device",
          expired_in: 60,
          interval: 0,
        })
      }
      if (url.endsWith("/oauth/token")) {
        const body = init?.body as URLSearchParams
        expect(body.get("grant_type")).toBe(MiniMaxProvider.GRANT_TYPE)
        expect(body.get("user_code")).toBe("MINIMAX-CODE")
        expect(body.get("code_verifier")).toBeTruthy()
        return jsonResponse({
          status: "success",
          access_token: "minimax-access",
          refresh_token: "minimax-refresh",
          expired_in: 3600,
        })
      }
      throw new Error(`unexpected URL ${url}`)
    }),
  )
  expect(authorize.instructions).toBe("MINIMAX-CODE")
  expect(authorize.method).toBe("auto")
  if (authorize.method !== "auto") throw new Error("expected auto user-code flow")
  const login = await authorize.callback()
  expect(login.type).toBe("success")
  if (login.type !== "success" || !("refresh" in login)) throw new Error("expected oauth success")

  await Auth.set(MiniMaxProvider.PROVIDER_ID, {
    type: "oauth",
    access: "old-minimax-access",
    refresh: login.refresh,
    expires: nowSeconds() - 1,
  })
  const resolved = await MiniMaxProvider.resolveToken({
    fetch: asFetch(async (input, init) => {
      expect(String(input)).toBe("https://api.minimax.io/oauth/token")
      const body = init?.body as URLSearchParams
      expect(body.get("grant_type")).toBe("refresh_token")
      expect(body.get("refresh_token")).toBe("minimax-refresh")
      return jsonResponse({
        access_token: "minimax-refreshed",
        refresh_token: "minimax-refresh-2",
        expired_in: 3600,
      })
    }),
  })
  expect(resolved).toBe("minimax-refreshed")

  globalThis.fetch = asFetch(async (_input, init) => {
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer minimax-refreshed")
    return jsonResponse({ ok: true })
  })
  await MiniMaxProvider.minimaxFetch("https://api.minimax.io/anthropic/v1/messages")
})

test("minimax request rejection recovers once and invalid refresh requires reconnect", async () => {
  await Auth.set(MiniMaxProvider.PROVIDER_ID, {
    type: "oauth",
    access: "minimax-old",
    refresh: "minimax-refresh",
    expires: nowSeconds() + 3600,
  })
  let refreshes = 0
  globalThis.fetch = asFetch(async (input, init) => {
    if (String(input) === `${MiniMaxProvider.GLOBAL_BASE}/oauth/token`) {
      refreshes++
      return jsonResponse({ access_token: "minimax-new", refresh_token: "minimax-refresh-2", expired_in: 3600 })
    }
    return new Headers(init?.headers).get("authorization") === "Bearer minimax-new"
      ? jsonResponse({ ok: true })
      : jsonResponse({ error: "invalid_token" }, { status: 401 })
  })
  expect((await MiniMaxProvider.minimaxFetch(`${MiniMaxProvider.GLOBAL_INFERENCE}/v1/messages`)).status).toBe(200)
  expect(refreshes).toBe(1)

  await Auth.set(MiniMaxProvider.PROVIDER_ID, {
    type: "oauth",
    access: "minimax-rejected",
    refresh: "minimax-invalid-refresh",
    expires: nowSeconds() + 3600,
  })
  globalThis.fetch = asFetch(async (input) =>
    String(input) === `${MiniMaxProvider.GLOBAL_BASE}/oauth/token`
      ? jsonResponse({ error: "invalid_grant" }, { status: 401 })
      : jsonResponse({ error: "invalid_token" }, { status: 401 }),
  )
  await expect(MiniMaxProvider.minimaxFetch(`${MiniMaxProvider.GLOBAL_INFERENCE}/v1/messages`)).rejects.toMatchObject({
    name: "ProviderAuthenticationRequiredError",
  })
})

test("copilot clears a rejected API token, exchanges once, and retries", async () => {
  await Auth.set(CopilotProvider.PROVIDER_ID, { type: "api", key: "github-device-token" })
  let exchanges = 0
  let requests = 0
  globalThis.fetch = asFetch(async (input, init) => {
    if (String(input) === CopilotProvider.TOKEN_EXCHANGE_URL) {
      exchanges++
      return jsonResponse({ token: `copilot-${exchanges}`, expires_at: nowSeconds() + 3600 })
    }
    requests++
    return new Headers(init?.headers).get("authorization") === "Bearer copilot-2"
      ? jsonResponse({ ok: true })
      : jsonResponse({ error: "invalid_token" }, { status: 401 })
  })

  const response = await CopilotProvider.copilotFetch("https://api.githubcopilot.com/chat/completions")
  expect(response.status).toBe(200)
  expect(exchanges).toBe(2)
  expect(requests).toBe(2)
})
