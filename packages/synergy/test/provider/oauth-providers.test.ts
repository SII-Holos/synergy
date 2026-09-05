import { afterEach, beforeEach, expect, test } from "bun:test"
import { Global } from "../../src/global"
import { Auth } from "../../src/provider/api-key"
import { GrokProvider } from "../../src/provider/grok"
import { AnthropicOAuthProvider } from "../../src/provider/anthropic-oauth"
import { CopilotProvider } from "../../src/provider/copilot"
import { ProviderCatalog } from "../../src/provider/catalog"
import { MiniMaxProvider } from "../../src/provider/minimax"
import { GitHubProvider } from "../../src/provider/github"
import { ProviderAuth } from "../../src/provider/auth"
import { ProviderDeviceCode } from "../../src/provider/device-code"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const originalFetch = globalThis.fetch
const originalGHToken = process.env.GH_TOKEN
const originalGITHUBToken = process.env.GITHUB_TOKEN
const secondaryAnthropicProviderID = "anthropic-secondary-test"
const secondaryMiniMaxProviderID = "minimax-secondary-test"
const mappedAnthropicProviderID = "anthropic-mapped-auth-test"
const mappedCopilotProviderID = "copilot-mapped-auth-test"

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
    GrokProvider.PROVIDER_ID,
    AnthropicOAuthProvider.PROVIDER_ID,
    CopilotProvider.PROVIDER_ID,
    CopilotProvider.ENTERPRISE_PROVIDER_ID,
    MiniMaxProvider.PROVIDER_ID,
    secondaryAnthropicProviderID,
    secondaryMiniMaxProviderID,
    mappedAnthropicProviderID,
    mappedCopilotProviderID,
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

test("mapped Anthropic auth methods persist OAuth credentials under the connection ID", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/synergy.json`,
        JSON.stringify({
          provider: {
            [mappedAnthropicProviderID]: {
              profile: AnthropicOAuthProvider.PROVIDER_ID,
              modelsDevProviderID: "anthropic",
            },
          },
        }),
      )
    },
  })
  globalThis.fetch = asFetch(async () =>
    jsonResponse({
      access_token: "mapped-anthropic-access",
      refresh_token: "mapped-anthropic-refresh",
      expires_in: 3600,
    }),
  )

  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      const methods = await ProviderAuth.methods()
      expect(methods[mappedAnthropicProviderID]).toEqual(methods[AnthropicOAuthProvider.PROVIDER_ID])
      const authorization = await ProviderAuth.authorize({ providerID: mappedAnthropicProviderID, method: 0 })
      const state = new URL(authorization!.url).searchParams.get("state")
      await ProviderAuth.callback({
        providerID: mappedAnthropicProviderID,
        method: 0,
        code: `mapped-code#${state}`,
      })
    },
  })

  expect(await Auth.get(mappedAnthropicProviderID)).toMatchObject({
    type: "oauth",
    access: "mapped-anthropic-access",
    refresh: "mapped-anthropic-refresh",
  })
  expect(await Auth.get(AnthropicOAuthProvider.PROVIDER_ID)).toBeUndefined()
})

test("mapped Copilot device auth binds the concrete connection ID", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/synergy.json`,
        JSON.stringify({
          provider: {
            [mappedCopilotProviderID]: {
              profile: CopilotProvider.PROVIDER_ID,
              modelsDevProviderID: CopilotProvider.PROVIDER_ID,
            },
          },
        }),
      )
    },
  })
  globalThis.fetch = asFetch(async (input) => {
    const url = String(input)
    if (url.endsWith("/login/device/code")) {
      return jsonResponse({
        device_code: "mapped-copilot-device",
        user_code: "MAPPED-COPILOT",
        verification_uri: "https://github.com/login/device",
        interval: 1,
        expires_in: 60,
      })
    }
    if (url.endsWith("/login/oauth/access_token")) {
      return jsonResponse({ access_token: "mapped-copilot-token" })
    }
    throw new Error(`unexpected URL ${url}`)
  })

  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      await ProviderAuth.authorize({ providerID: mappedCopilotProviderID, method: 0 })
      await ProviderAuth.callback({ providerID: mappedCopilotProviderID, method: 0 })
    },
  })

  expect(await Auth.get(mappedCopilotProviderID)).toEqual({
    type: "api",
    key: "mapped-copilot-token",
  })
  expect(await Auth.get(CopilotProvider.PROVIDER_ID)).toBeUndefined()
})

test("mapped Copilot enterprise auth preserves the enterprise host", async () => {
  const previousEnterpriseURL = process.env.COPILOT_GITHUB_ENTERPRISE_URL
  process.env.COPILOT_GITHUB_ENTERPRISE_URL = "https://global.enterprise.invalid"
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/synergy.json`,
          JSON.stringify({
            provider: {
              [mappedCopilotProviderID]: {
                profile: CopilotProvider.ENTERPRISE_PROVIDER_ID,
                modelsDevProviderID: CopilotProvider.PROVIDER_ID,
                options: {
                  enterpriseUrl: "https://connection.enterprise.invalid",
                },
              },
            },
          }),
        )
      },
    })
    let deviceCodeURL: string | undefined
    globalThis.fetch = asFetch(async (input) => {
      deviceCodeURL = String(input)
      return jsonResponse({
        device_code: "mapped-enterprise-device",
        user_code: "ENTERPRISE",
        verification_uri: "https://connection.enterprise.invalid/login/device",
        interval: 1,
        expires_in: 60,
      })
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        await ProviderAuth.authorize({ providerID: mappedCopilotProviderID, method: 0 })
      },
    })

    expect(deviceCodeURL).toBe("https://connection.enterprise.invalid/login/device/code")
  } finally {
    if (previousEnterpriseURL === undefined) delete process.env.COPILOT_GITHUB_ENTERPRISE_URL
    else process.env.COPILOT_GITHUB_ENTERPRISE_URL = previousEnterpriseURL
  }
})

test("mapped Copilot auth forwards cancellation to the device callback", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/synergy.json`,
        JSON.stringify({
          provider: {
            [mappedCopilotProviderID]: {
              profile: CopilotProvider.PROVIDER_ID,
              modelsDevProviderID: CopilotProvider.PROVIDER_ID,
            },
          },
        }),
      )
    },
  })
  let polls = 0
  globalThis.fetch = asFetch(async (input) => {
    const url = String(input)
    if (url.endsWith("/login/device/code")) {
      return jsonResponse({
        device_code: "mapped-cancelled-device",
        user_code: "STOP-MAPPED",
        verification_uri: "https://github.com/login/device",
        interval: 1,
        expires_in: 60,
      })
    }
    if (url.endsWith("/login/oauth/access_token")) {
      polls++
      return jsonResponse({ access_token: "unexpected-mapped-token" })
    }
    throw new Error(`unexpected URL ${url}`)
  })

  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      const input = { providerID: mappedCopilotProviderID, method: 0 }
      await ProviderAuth.authorize(input)
      const controller = new AbortController()
      controller.abort()
      const result = await ProviderAuth.callback({ ...input, signal: controller.signal }).catch((error) => error)
      expect(result).toBeInstanceOf(ProviderAuth.OauthCallbackFailed)
    },
  })

  expect(polls).toBe(0)
  expect(await Auth.get(mappedCopilotProviderID)).toBeUndefined()
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

test("anthropic refresh rejection preserves and retries a healthy backup credential", async () => {
  await Auth.set(secondaryAnthropicProviderID, {
    type: "oauth",
    access: "anthropic-expired-primary",
    refresh: "anthropic-rejected-refresh",
    expires: nowSeconds() - 1,
  })
  await Auth.addToPool(secondaryAnthropicProviderID, "anthropic-backup", {
    type: "oauth",
    access: "anthropic-backup-access",
    refresh: "anthropic-backup-refresh",
    expires: nowSeconds() + 3600,
  })
  let refreshes = 0
  globalThis.fetch = asFetch(async (input, init) => {
    if (AnthropicOAuthProvider.OAUTH_TOKEN_URLS.some((url) => url === String(input))) {
      refreshes++
      expect(JSON.parse(String(init?.body)).refresh_token).toBe("anthropic-rejected-refresh")
      return jsonResponse({ error: "invalid_grant" }, { status: 401 })
    }
    const authorization = new Headers(init?.headers).get("authorization")
    return authorization === "Bearer anthropic-backup-access"
      ? jsonResponse({ ok: true })
      : jsonResponse({ type: "authentication_error" }, { status: 401 })
  })

  const response = await AnthropicOAuthProvider.anthropicFetchFor(secondaryAnthropicProviderID)(
    "https://api.anthropic.com/v1/messages",
  )

  expect(response.status).toBe(200)
  expect(refreshes).toBe(1)
  expect((await Auth.select(secondaryAnthropicProviderID))?.credentialID).toBe("anthropic-backup")
})

test("anthropicFetchFor binds requests to the selected connection credential", async () => {
  await Auth.set(AnthropicOAuthProvider.PROVIDER_ID, {
    type: "oauth",
    access: "anthropic-canonical",
    refresh: "anthropic-canonical-refresh",
    expires: nowSeconds() + 3600,
  })
  await Auth.set(secondaryAnthropicProviderID, {
    type: "oauth",
    access: "anthropic-secondary",
    refresh: "anthropic-secondary-refresh",
    expires: nowSeconds() + 3600,
  })
  globalThis.fetch = asFetch(async (_input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer anthropic-secondary")
    return jsonResponse({ ok: true })
  })

  await AnthropicOAuthProvider.anthropicFetchFor(secondaryAnthropicProviderID)("https://api.anthropic.com/v1/messages")

  expect(await Auth.get(AnthropicOAuthProvider.PROVIDER_ID)).toMatchObject({
    type: "oauth",
    access: "anthropic-canonical",
  })
})

test("mapped Copilot requests prefer the connection credential over global tokens", async () => {
  const previousGitHubToken = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = "global-copilot-token"
  await Auth.set(mappedCopilotProviderID, { type: "api", key: "mapped-copilot-token" })
  CopilotProvider.clearApiToken(mappedCopilotProviderID)
  try {
    globalThis.fetch = asFetch(async (input, init) => {
      const url = String(input)
      if (url === CopilotProvider.TOKEN_EXCHANGE_URL) {
        expect(new Headers(init?.headers).get("authorization")).toBe("token mapped-copilot-token")
        return jsonResponse({ token: "mapped-copilot-api-token", expires_at: nowSeconds() + 3600 })
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mapped-copilot-api-token")
      return jsonResponse({ ok: true })
    })

    const response = await CopilotProvider.copilotFetchFor(mappedCopilotProviderID)(
      "https://api.githubcopilot.com/chat/completions",
    )
    expect(response.status).toBe(200)
  } finally {
    CopilotProvider.clearApiToken(mappedCopilotProviderID)
    await Auth.remove(mappedCopilotProviderID)
    if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousGitHubToken
  }
})

test("inline Copilot auth overrides stored credentials without changing their health", async () => {
  await Auth.set(mappedCopilotProviderID, { type: "api", key: "stored-copilot-token" })
  CopilotProvider.clearApiToken(mappedCopilotProviderID)
  const exchanges: string[] = []
  let requests = 0
  globalThis.fetch = asFetch(async (input, init) => {
    const authorization = new Headers(init?.headers).get("authorization")
    if (String(input) === CopilotProvider.TOKEN_EXCHANGE_URL) {
      exchanges.push(authorization ?? "")
      return jsonResponse({
        token: `inline-copilot-api-token-${exchanges.length}`,
        expires_at: nowSeconds() + 3600,
      })
    }
    requests++
    return requests === 1 ? jsonResponse({ error: "invalid_token" }, { status: 401 }) : jsonResponse({ ok: true })
  })

  const response = await CopilotProvider.copilotFetchFor(mappedCopilotProviderID, {
    type: "api",
    key: "inline-copilot-token",
  })("https://api.githubcopilot.com/chat/completions")

  expect(response.status).toBe(200)
  expect(exchanges).toEqual(["token inline-copilot-token", "token inline-copilot-token"])
  expect(await Auth.get(mappedCopilotProviderID)).toMatchObject({
    type: "api",
    key: "stored-copilot-token",
  })
})

test("inline Copilot auth is used for mapped connection catalog discovery", async () => {
  await Auth.set(mappedCopilotProviderID, { type: "api", key: "stored-copilot-token" })
  CopilotProvider.clearApiToken(mappedCopilotProviderID)
  const authorizations: string[] = []
  const catalog = await CopilotProvider.fetchModelCatalog(
    mappedCopilotProviderID,
    asFetch(async (input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? ""
      authorizations.push(authorization)
      if (String(input) === CopilotProvider.TOKEN_EXCHANGE_URL) {
        return jsonResponse({ token: "inline-copilot-api-token", expires_at: nowSeconds() + 3600 })
      }
      return jsonResponse({ data: [{ id: "gpt-inline-catalog" }] })
    }),
    { type: "api", key: "inline-copilot-token" },
  )

  expect(catalog).toEqual([{ id: "gpt-inline-catalog" }])
  expect(authorizations).toEqual(["token inline-copilot-token", "Bearer inline-copilot-api-token"])
  expect(await Auth.get(mappedCopilotProviderID)).toMatchObject({
    type: "api",
    key: "stored-copilot-token",
  })
})

test("mapped Copilot requests reselect a backup credential after failover", async () => {
  await Auth.set(mappedCopilotProviderID, { type: "api", key: "primary-copilot-token" })
  await Auth.addToPool(mappedCopilotProviderID, "backup-copilot", {
    type: "api",
    key: "backup-copilot-token",
  })
  const initialAuth = await Auth.get(mappedCopilotProviderID)
  CopilotProvider.clearApiToken(mappedCopilotProviderID)
  const exchanges: string[] = []
  globalThis.fetch = asFetch(async (input, init) => {
    const url = String(input)
    const authorization = new Headers(init?.headers).get("authorization")
    if (url === CopilotProvider.TOKEN_EXCHANGE_URL) {
      exchanges.push(authorization ?? "")
      if (authorization === "token primary-copilot-token" && exchanges.length === 1) {
        return jsonResponse({ token: "primary-copilot-api-token", expires_at: nowSeconds() + 3600 })
      }
      if (authorization === "token backup-copilot-token") {
        return jsonResponse({ token: "backup-copilot-api-token", expires_at: nowSeconds() + 3600 })
      }
      return jsonResponse({ error: "bad_credentials" }, { status: 401 })
    }
    if (authorization === "Bearer backup-copilot-api-token") return jsonResponse({ ok: true })
    return jsonResponse({ error: "invalid_token" }, { status: 401 })
  })

  const response = await CopilotProvider.copilotFetchFor(
    mappedCopilotProviderID,
    initialAuth,
  )("https://api.githubcopilot.com/chat/completions")

  expect(response.status).toBe(200)
  expect(exchanges).toEqual([
    "token primary-copilot-token",
    "token primary-copilot-token",
    "token backup-copilot-token",
  ])
  expect((await Auth.select(mappedCopilotProviderID))?.credentialID).toBe("backup-copilot")
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

test("github copilot device login recovers from a transient polling timeout", async () => {
  let polls = 0
  const authorize = await CopilotProvider.authorizeDeviceCode(
    CopilotProvider.PROVIDER_ID,
    asFetch(async (input) => {
      const url = String(input)
      if (url.endsWith("/login/device/code")) {
        return jsonResponse({
          device_code: "device-transient",
          user_code: "TIME-OUT1",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 60,
        })
      }
      if (url.endsWith("/login/oauth/access_token")) {
        polls++
        if (polls === 1) throw new DOMException("poll timed out", "TimeoutError")
        return jsonResponse({ access_token: "github-recovered-token" })
      }
      throw new Error(`unexpected URL ${url}`)
    }),
  )

  if (authorize.method !== "auto") throw new Error("expected auto device flow")
  await expect(authorize.callback()).resolves.toEqual({
    type: "success",
    provider: CopilotProvider.PROVIDER_ID,
    key: "github-recovered-token",
  })
  expect(polls).toBe(2)
})

test("provider auth stops a cancelled device callback before polling", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      let polls = 0
      globalThis.fetch = asFetch(async (input) => {
        const url = String(input)
        if (url.endsWith("/login/device/code")) {
          return jsonResponse({
            device_code: "device-cancelled",
            user_code: "STOP-NOW",
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 60,
          })
        }
        if (url.endsWith("/login/oauth/access_token")) {
          polls++
          return jsonResponse({ access_token: "unexpected-token" })
        }
        throw new Error(`unexpected URL ${url}`)
      })

      const input = { providerID: CopilotProvider.PROVIDER_ID, method: 0 }
      await ProviderAuth.authorize(input)
      const controller = new AbortController()
      controller.abort()

      const result = await ProviderAuth.callback({ ...input, signal: controller.signal }).catch((error) => error)
      expect(result).toBeInstanceOf(ProviderAuth.OauthCallbackFailed)
      expect(polls).toBe(0)
    },
  })
})

test("device login caps an upstream expiry at fifteen minutes", () => {
  expect(ProviderDeviceCode.expirySeconds(3600)).toBe(900)
  expect(ProviderDeviceCode.expirySeconds(undefined)).toBe(900)
})

test("a completed device callback preserves a newer pending authorization", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      let authorizations = 0
      let releaseFirstPoll = () => {}
      const firstPollStarted = new Promise<void>((resolveStarted) => {
        globalThis.fetch = asFetch(async (input, init) => {
          const url = String(input)
          if (url.endsWith("/login/device/code")) {
            authorizations++
            return jsonResponse({
              device_code: `device-${authorizations}`,
              user_code: `FLOW-${authorizations}`,
              verification_uri: "https://github.com/login/device",
              interval: 1,
              expires_in: 60,
            })
          }
          if (url.endsWith("/login/oauth/access_token")) {
            const deviceCode = (init?.body as URLSearchParams).get("device_code")
            if (deviceCode === "device-1") {
              resolveStarted()
              await new Promise<void>((resolvePoll) => {
                releaseFirstPoll = resolvePoll
              })
              return jsonResponse({ access_token: "first-token" })
            }
            return jsonResponse({ error: "expired_token" })
          }
          throw new Error(`unexpected URL ${url}`)
        })
      })

      const input = { providerID: CopilotProvider.PROVIDER_ID, method: 0 }
      await ProviderAuth.authorize(input)
      const firstCallback = ProviderAuth.callback(input)
      await firstPollStarted
      await ProviderAuth.authorize(input)
      releaseFirstPoll()
      await firstCallback

      const controller = new AbortController()
      controller.abort()
      const second = await ProviderAuth.callback({ ...input, signal: controller.signal }).catch((error) => error)
      expect(second).toBeInstanceOf(ProviderAuth.OauthCallbackFailed)
    },
  })
})

test("provider auth consumes a failed device callback before another callback can reuse it", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      globalThis.fetch = asFetch(async (input) => {
        const url = String(input)
        if (url.endsWith("/login/device/code")) {
          return jsonResponse({
            device_code: "device-failed",
            user_code: "FAIL-ONCE",
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 60,
          })
        }
        if (url.endsWith("/login/oauth/access_token")) return jsonResponse({ error: "expired_token" })
        throw new Error(`unexpected URL ${url}`)
      })

      const input = { providerID: CopilotProvider.PROVIDER_ID, method: 0 }
      await ProviderAuth.authorize(input)
      const first = await ProviderAuth.callback(input).catch((error) => error)
      expect(first).toBeInstanceOf(ProviderAuth.OauthCallbackFailed)

      const second = await ProviderAuth.callback(input).catch((error) => error)
      expect(second).toBeInstanceOf(ProviderAuth.OauthMissing)
    },
  })
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
            {
              id: "unrestricted-vision-model",
              capabilities: {
                supports: { vision: true },
                limits: { vision: { supported_media_types: [] } },
              },
            },
          ],
        })
      }
      throw new Error(`unexpected URL ${url}`)
    }),
  )

  expect(catalog).toEqual([
    {
      id: "vision-model",
      inputImage: true,
      supportedImageMediaTypes: ["image/png", "image/jpeg"],
    },
    {
      id: "text-model",
      inputImage: false,
    },
    {
      id: "unrestricted-vision-model",
      inputImage: true,
      supportedImageMediaTypes: [],
    },
  ])
})

test("github copilot live catalog changes only image capability and preserves other modalities", async () => {
  await Auth.set(CopilotProvider.PROVIDER_ID, { type: "api", key: "github-device-token" })
  ProviderCatalog.reset()
  const config = {}
  const baseline = await ProviderCatalog.resolve({ forceRefresh: true, includeLive: false, config })
  const baselineModels = baseline[CopilotProvider.PROVIDER_ID].models
  const baselineInputs = (modelID: string) => baselineModels[modelID]?.modalities?.input ?? ["text"]
  const baselineVisionInputs = baselineInputs("gemini-2.5-pro")
  const baselineTextInputs = baselineInputs("gemini-2.0-flash-001")
  globalThis.fetch = asFetch(async (input) => {
    const url = String(input)
    if (url === CopilotProvider.TOKEN_EXCHANGE_URL) {
      return jsonResponse({ token: "copilot-api-token", expires_at: nowSeconds() + 3600 })
    }
    if (url === `${CopilotProvider.BASE_URL}/models`) {
      return jsonResponse({
        data: [
          {
            id: "gemini-2.5-pro",
            capabilities: {
              supports: { vision: true },
              limits: { vision: { supported_media_types: ["image/png", "image/jpeg"] } },
            },
          },
          {
            id: "gemini-2.0-flash-001",
            capabilities: { supports: { vision: false } },
          },
        ],
      })
    }
    throw new Error(`unexpected URL ${url}`)
  })

  await ProviderCatalog.refresh(CopilotProvider.PROVIDER_ID)
  const snapshot = JSON.parse(await Bun.file(Global.Path.providerModelCatalogCache).text()).snapshots.find(
    (entry: { providerID: string }) => entry.providerID === CopilotProvider.PROVIDER_ID,
  )
  expect(snapshot.activeModels).toContainEqual({
    id: "gemini-2.5-pro",
    inputImage: true,
    supportedImageMediaTypes: ["image/png", "image/jpeg"],
  })
  const catalog = await ProviderCatalog.resolve({
    forceRefresh: true,
    includeLive: true,
    config,
  })
  const models = catalog[CopilotProvider.PROVIDER_ID].models

  expect(models["gemini-2.5-pro"].modalities?.input).toContain("image")
  expect(models["gemini-2.5-pro"].modalities?.input.filter((modality) => modality !== "image")).toEqual(
    baselineVisionInputs.filter((modality) => modality !== "image"),
  )
  expect(models["gemini-2.5-pro"].supported_image_media_types).toEqual(["image/png", "image/jpeg"])
  expect(models["gemini-2.0-flash-001"].modalities?.input).not.toContain("image")
  expect(models["gemini-2.0-flash-001"].modalities?.input).toEqual(
    baselineTextInputs.filter((modality) => modality !== "image"),
  )
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

test("minimaxFetchFor binds requests to the selected connection credential", async () => {
  await Auth.set(MiniMaxProvider.PROVIDER_ID, {
    type: "oauth",
    access: "minimax-canonical",
    refresh: "minimax-canonical-refresh",
    expires: nowSeconds() + 3600,
  })
  await Auth.set(secondaryMiniMaxProviderID, {
    type: "oauth",
    access: "minimax-secondary",
    refresh: "minimax-secondary-refresh",
    expires: nowSeconds() + 3600,
  })
  globalThis.fetch = asFetch(async (_input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer minimax-secondary")
    return jsonResponse({ ok: true })
  })

  await MiniMaxProvider.minimaxFetchFor(secondaryMiniMaxProviderID)(`${MiniMaxProvider.GLOBAL_INFERENCE}/v1/messages`)

  expect(await Auth.get(MiniMaxProvider.PROVIDER_ID)).toMatchObject({
    type: "oauth",
    access: "minimax-canonical",
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
