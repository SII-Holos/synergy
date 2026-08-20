import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import { Auth } from "../../src/provider/api-key"
import { GrokProvider } from "../../src/provider/grok"
import { ProviderCatalog } from "../../src/provider/catalog"
import { Provider } from "../../src/provider/provider"
import { Global } from "../../src/global"
const originalFetch = globalThis.fetch
const secondaryProviderID = "grok-secondary-test"

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function makeJWT(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.signature`
}

function accessToken(input?: { exp?: number; sub?: string; email?: string }) {
  return makeJWT({
    exp: input?.exp ?? nowSeconds() + 60 * 60,
    ...(input?.sub !== undefined ? { sub: input.sub } : {}),
    ...(input?.email !== undefined ? { email: input.email } : {}),
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

async function resetGrokState() {
  globalThis.fetch = originalFetch
  await Auth.remove(GrokProvider.PROVIDER_ID)
  await Auth.remove(secondaryProviderID)
  await ProviderCatalog.reset()
  await Provider.reload()
  // ProviderCatalog snapshots persist under the real provider ID; delete the
  // cache file so tests cannot leak snapshots into each other.
  await fs.rm(Global.Path.providerModelCatalogCache, { force: true })
}
beforeEach(resetGrokState)
afterEach(resetGrokState)

test("device-code flow requests a device code with PKCE and exchanges it for OAuth tokens", async () => {
  const issuedAccess = accessToken()
  const calls: string[] = []
  const fetchFn = asFetch(async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/oauth2/device/code")) {
      expect(init?.method).toBe("POST")
      const body = init?.body as URLSearchParams
      expect(body.get("client_id")).toBe(GrokProvider.OAUTH_CLIENT_ID)
      expect(body.get("scope")).toBe(GrokProvider.OAUTH_SCOPES)
      expect(body.get("code_challenge_method")).toBe("S256")
      expect(body.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/)
      return jsonResponse({
        device_code: "device-1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        interval: 1,
      })
    }
    if (url.endsWith("/oauth2/token")) {
      const body = init?.body as URLSearchParams
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
      expect(body.get("device_code")).toBe("device-1")
      expect(body.get("client_id")).toBe(GrokProvider.OAUTH_CLIENT_ID)
      expect(body.get("code_verifier")).toBeTruthy()
      return jsonResponse({ access_token: issuedAccess, refresh_token: "refresh-1", expires_in: 3600 })
    }
    throw new Error(`unexpected URL ${url}`)
  })

  const { device, codeVerifier } = await GrokProvider.requestDeviceCode(fetchFn)
  expect(device.deviceCode).toBe("device-1")
  expect(device.userCode).toBe("ABCD-EFGH")
  expect(device.verificationURI).toBe("https://accounts.x.ai/oauth2/device")
  expect(device.intervalSeconds).toBe(3)
  expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/)

  const token = await GrokProvider.pollDeviceCode({ device: { ...device, intervalSeconds: 0 }, codeVerifier }, fetchFn)
  expect(token.access).toBe(issuedAccess)
  expect(token.refresh).toBe("refresh-1")
  expect(calls).toEqual(["https://auth.x.ai/oauth2/device/code", "https://auth.x.ai/oauth2/token"])
})

test("authorizeDeviceCode exposes verification URL and user code and completes via callback", async () => {
  const issuedAccess = accessToken()
  const fetchFn = asFetch(async (input, init) => {
    const url = String(input)
    if (url.endsWith("/oauth2/device/code")) {
      return jsonResponse({
        device_code: "device-2",
        user_code: "WXYZ-1234",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        interval: 1,
      })
    }
    if (url.endsWith("/oauth2/token")) {
      return jsonResponse({ access_token: issuedAccess, refresh_token: "refresh-2", expires_in: 3600 })
    }
    throw new Error(`unexpected URL ${url}`)
  })

  const authorize = await GrokProvider.authorizeDeviceCode(fetchFn)
  expect(authorize.url).toBe("https://accounts.x.ai/oauth2/device")
  expect(authorize.method).toBe("auto")
  const result = await (authorize as { callback: () => Promise<unknown> }).callback()

  expect(result).toEqual({
    type: "success",
    access: issuedAccess,
    refresh: "refresh-2",
    expires: nowSeconds() + 3600,
  })
})

test("device-code poll continues on authorization_pending and slows down on slow_down", async () => {
  const issuedAccess = accessToken()
  let polls = 0
  const fetchFn = asFetch(async (_input, init) => {
    polls++
    if (polls === 1) return jsonResponse({ error: "authorization_pending" }, { status: 400 })
    if (polls === 2) return jsonResponse({ error: "slow_down" }, { status: 400 })
    const body = init?.body as URLSearchParams
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
    return jsonResponse({ access_token: issuedAccess, refresh_token: "refresh-3", expires_in: 3600 })
  })

  const sleeps: number[] = []
  const token = await GrokProvider.pollDeviceCode(
    {
      device: {
        deviceCode: "device-3",
        userCode: "ABCD",
        verificationURI: "https://accounts.x.ai/oauth2/device",
        intervalSeconds: 0,
      },
      codeVerifier: "verifier-3",
    },
    fetchFn,
    async (ms) => {
      sleeps.push(ms)
    },
  )
  expect(token.access).toBe(issuedAccess)
  expect(polls).toBe(3)
  // RFC 8628 slow_down increases the poll interval by 5 seconds.
  expect(sleeps).toEqual([0, 0, 5000])
})

test("device-code poll treats access_denied as a relogin-required failure", async () => {
  const fetchFn = asFetch(async () =>
    jsonResponse({ error: "access_denied", error_description: "denied" }, { status: 400 }),
  )
  let thrown: unknown
  try {
    await GrokProvider.pollDeviceCode(
      {
        device: {
          deviceCode: "device-4",
          userCode: "ABCD",
          verificationURI: "https://accounts.x.ai/oauth2/device",
          intervalSeconds: 0,
        },
        codeVerifier: "verifier-4",
      },
      fetchFn,
    )
  } catch (error) {
    thrown = error
  }
  expect(GrokProvider.AuthError.isInstance(thrown)).toBe(true)
  if (GrokProvider.AuthError.isInstance(thrown)) {
    expect(thrown.data.reloginRequired).toBe(true)
    expect(thrown.data.code).toBe("access_denied")
  }
})

test("resolveToken returns fresh access token without refreshing", async () => {
  const token = accessToken()
  await Auth.set(GrokProvider.PROVIDER_ID, {
    type: "oauth",
    access: token,
    refresh: "refresh-existing",
    expires: nowSeconds() + 60 * 60,
  })

  let refreshCalls = 0
  const resolved = await GrokProvider.resolveToken({
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
  const newToken = accessToken({ exp: nowSeconds() + 60 * 60 })
  await Auth.set(GrokProvider.PROVIDER_ID, {
    type: "oauth",
    access: oldToken,
    refresh: "refresh-old",
    expires: nowSeconds() + 30,
  })

  const resolved = await GrokProvider.resolveToken({
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://auth.x.ai/oauth2/token")
      const body = init?.body as URLSearchParams
      expect(body.get("grant_type")).toBe("refresh_token")
      expect(body.get("refresh_token")).toBe("refresh-old")
      expect(body.get("client_id")).toBe(GrokProvider.OAUTH_CLIENT_ID)
      return jsonResponse({ access_token: newToken, refresh_token: "refresh-new", expires_in: 3600 })
    },
  })

  const stored = await Auth.get(GrokProvider.PROVIDER_ID)
  expect(resolved).toBe(newToken)
  expect(stored?.type).toBe("oauth")
  if (stored?.type === "oauth") {
    expect(stored.access).toBe(newToken)
    expect(stored.refresh).toBe("refresh-new")
  }
})

test("resolveToken keeps current token on refresh rate limit but marks credentials dead on invalid grant", async () => {
  const staleToken = accessToken({ exp: nowSeconds() - 30 })
  await Auth.set(GrokProvider.PROVIDER_ID, {
    type: "oauth",
    access: staleToken,
    refresh: "refresh-old",
    expires: nowSeconds() - 30,
  })

  const rateLimited = await GrokProvider.resolveToken({
    fetch: async () => jsonResponse({ error: "rate_limited" }, { status: 429 }),
  })
  expect(rateLimited).toBe(staleToken)

  let thrown: unknown
  try {
    await GrokProvider.resolveToken({
      fetch: async () =>
        jsonResponse({ error: "invalid_grant", error_description: "refresh token reused" }, { status: 400 }),
    })
  } catch (error) {
    thrown = error
  }

  expect(GrokProvider.AuthError.isInstance(thrown)).toBe(true)
  if (GrokProvider.AuthError.isInstance(thrown)) {
    expect(thrown.data.reloginRequired).toBe(true)
  }
  // Invalid grant marks the credential dead, so it is no longer selectable.
  expect(await Auth.get(GrokProvider.PROVIDER_ID)).toBeUndefined()
})

test("grokFetch injects Bearer token and Synergy headers", async () => {
  const token = accessToken()
  await Auth.set(GrokProvider.PROVIDER_ID, {
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

  await GrokProvider.grokFetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "grok-4.5", messages: [{ role: "user", content: "hello" }] }),
  })

  expect(captured?.input).toBe("https://api.x.ai/v1/chat/completions")
  const headers = new Headers(captured?.init?.headers)
  expect(headers.get("authorization")).toBe(`Bearer ${token}`)
  expect(headers.get("user-agent")).toBe("synergy")
  expect(headers.get("x-grok-client-surface")).toBe("synergy")
})

test("grokFetchFor binds requests to the selected connection credential", async () => {
  const canonicalToken = accessToken()
  const secondaryToken = accessToken()
  await Auth.set(GrokProvider.PROVIDER_ID, {
    type: "oauth",
    access: canonicalToken,
    refresh: "refresh-canonical",
    expires: nowSeconds() + 60 * 60,
  })
  await Auth.set(secondaryProviderID, {
    type: "oauth",
    access: secondaryToken,
    refresh: "refresh-secondary",
    expires: nowSeconds() + 60 * 60,
  })

  globalThis.fetch = asFetch(async (_input, init) => {
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${secondaryToken}`)
    return jsonResponse({ ok: true })
  })

  await GrokProvider.grokFetchFor(secondaryProviderID)("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "grok-4.5", messages: [] }),
  })

  expect(await Auth.get(GrokProvider.PROVIDER_ID)).toMatchObject({ type: "oauth", access: canonicalToken })
  expect(await Auth.get(secondaryProviderID)).toMatchObject({ type: "oauth", access: secondaryToken })
})

test("classifyError maps 401 and invalid_grant to relogin required but leaves 403 unclassified", () => {
  expect(GrokProvider.classifyError({ status: 401 })).toMatchObject({ reloginRequired: true, retryable: false })
  expect(GrokProvider.classifyError({ status: 400, body: { error: { code: "invalid_grant" } } })).toMatchObject({
    reloginRequired: true,
  })
  expect(GrokProvider.classifyError({ status: 429 })).toMatchObject({ retryable: true, exhausted: true })
  expect(GrokProvider.classifyError({ status: 403, body: { error: { code: "not_allowed" } } })).toBeUndefined()
})
test("grokAccountID extracts a stable account identity from JWT claims", () => {
  expect(GrokProvider.grokAccountID(accessToken({ sub: "user-123" }))).toBe("sub:user-123")
  expect(GrokProvider.grokAccountID(accessToken({ email: "a@example.com" }))).toBe("email:a@example.com")
  expect(GrokProvider.grokAccountID(accessToken({ sub: "user-123", email: "a@example.com" }))).toBe("sub:user-123")
  expect(GrokProvider.grokAccountID(accessToken())).toBeUndefined()
  expect(GrokProvider.grokAccountID("not-a-jwt")).toBeUndefined()
})

test("fetchModelCatalog hits /v1/language-models with Bearer and maps entries without inventing limits", async () => {
  const token = accessToken()
  const catalog = await GrokProvider.fetchModelCatalog(
    token,
    asFetch(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/language-models")
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${token}`)
      expect(headers.get("user-agent")).toBe("synergy")
      expect(headers.get("x-grok-client-surface")).toBe("synergy")
      return jsonResponse({
        models: [
          { id: "grok-4.6", input_modalities: ["text"], output_modalities: ["text"], context_length: 524_288 },
          { id: "grok-4.3", input_modalities: ["text"], output_modalities: ["text"] },
          { id: "grok-4.5", input_modalities: ["text", "image"], output_modalities: ["text"] },
        ],
      })
    }),
  )
  // xAI /v1/language-models documents no context_length and no output limit;
  // entries carry only the id plus the vision flag so limit metadata inherits
  // from models.dev / the bundled fallback.
  expect(catalog).toEqual([{ id: "grok-4.6" }, { id: "grok-4.3" }, { id: "grok-4.5", inputImage: true }])
})

test("fetchModelCatalog returns [] on non-2xx and malformed envelopes", async () => {
  const token = accessToken()
  expect(
    await GrokProvider.fetchModelCatalog(
      token,
      asFetch(async () => jsonResponse({ error: { code: "not_allowed" } }, { status: 403 })),
    ),
  ).toEqual([])
  expect(
    await GrokProvider.fetchModelCatalog(
      token,
      asFetch(async () => jsonResponse({ error: "boom" }, { status: 500 })),
    ),
  ).toEqual([])
  expect(
    await GrokProvider.fetchModelCatalog(
      token,
      asFetch(async () => jsonResponse({ data: [{ id: "grok-4.6" }] })),
    ),
  ).toEqual([])
  expect(
    await GrokProvider.fetchModelCatalog(
      token,
      asFetch(async () => jsonResponse({ models: [{ id: "" }, { id: "grok-4.6" }, null, "grok-4.5"] })),
    ),
  ).toEqual([{ id: "grok-4.6" }])
})

test("fetchModelCatalog propagates timeouts and network errors for failure classification", async () => {
  const token = accessToken()
  await expect(
    GrokProvider.fetchModelCatalog(
      token,
      asFetch(async () => {
        throw new DOMException("timed out", "TimeoutError")
      }),
    ),
  ).rejects.toMatchObject({ name: "TimeoutError" })
  await expect(
    GrokProvider.fetchModelCatalog(
      token,
      asFetch(async () => {
        throw new TypeError("fetch failed")
      }),
    ),
  ).rejects.toMatchObject({ name: "TypeError", message: "fetch failed" })
})

test("provider catalog caches static and live Grok models independently", async () => {
  // First ProviderCatalog.resolve in the suite pays the models.dev runtime
  // warm-up cost; allow extra time so a cold cache does not flake the test.
  const token = accessToken({ sub: "catalog-account" })
  await Auth.set(GrokProvider.PROVIDER_ID, {
    type: "oauth",
    access: token,
    refresh: "refresh-provider-catalog",
    expires: nowSeconds() + 60 * 60,
  })
  let discoveryCalls = 0
  globalThis.fetch = asFetch(async () => {
    discoveryCalls += 1
    return jsonResponse({ models: [{ id: "grok-4.6" }, { id: "grok-account-live-only" }] })
  })
  const config = { providerCatalog: { enabled: false, offlineCache: false } }

  await ProviderCatalog.refresh(GrokProvider.PROVIDER_ID)
  ProviderCatalog.reset()

  const staticCatalog = await ProviderCatalog.resolve({ config, includeLive: false })
  const liveCatalog = await ProviderCatalog.resolve({ config, includeLive: true })
  const cachedLiveCatalog = await ProviderCatalog.resolve({ config, includeLive: true })

  expect(staticCatalog[GrokProvider.PROVIDER_ID].models["grok-account-live-only"]).toBeUndefined()
  expect(liveCatalog[GrokProvider.PROVIDER_ID].models["grok-4.6"]).toBeDefined()
  expect(liveCatalog[GrokProvider.PROVIDER_ID].models["grok-account-live-only"]).toBeDefined()
  expect(cachedLiveCatalog[GrokProvider.PROVIDER_ID].models["grok-account-live-only"]).toBeDefined()
  expect(discoveryCalls).toBe(1)
}, 30_000)

test("failed Grok discovery falls back to the bundled list without error", async () => {
  const token = accessToken({ sub: "fallback-account" })
  await Auth.set(GrokProvider.PROVIDER_ID, {
    type: "oauth",
    access: token,
    refresh: "refresh-failure",
    expires: nowSeconds() + 60 * 60,
  })
  globalThis.fetch = asFetch(async () => jsonResponse({ error: { code: "not_allowed" } }, { status: 403 }))

  const catalog = await ProviderCatalog.resolve({
    forceRefresh: true,
    includeLive: true,
    config: { providerCatalog: { enabled: false, offlineCache: false } },
  })
  const grok = catalog[GrokProvider.PROVIDER_ID]
  expect(grok.models["grok-4.6"]).toBeDefined()
  expect(Object.keys(grok.models).length).toBeGreaterThan(0)
})

test("Grok catalog identity stays stable across refresh-token rotation", async () => {
  const config = { providerCatalog: { enabled: false, offlineCache: false } }
  globalThis.fetch = asFetch(async () => jsonResponse({ models: [{ id: "grok-4.6" }] }))

  await Auth.set(GrokProvider.PROVIDER_ID, {
    type: "oauth",
    access: accessToken({ sub: "stable-user" }),
    refresh: "refresh-rotated-1",
    expires: nowSeconds() + 60 * 60,
  })
  await ProviderCatalog.refresh(GrokProvider.PROVIDER_ID)
  ProviderCatalog.reset()

  // xAI rotates and revokes the refresh token on every refresh; the access
  // token's subject stays stable, so the live snapshot must survive rotation.
  await Auth.set(GrokProvider.PROVIDER_ID, {
    type: "oauth",
    access: accessToken({ sub: "stable-user" }),
    refresh: "refresh-rotated-2",
    expires: nowSeconds() + 60 * 60,
  })
  const rotated = await ProviderCatalog.resolve({ config, includeLive: true })
  expect(rotated[GrokProvider.PROVIDER_ID].models["grok-4.6"].catalog_state).toBe("active")
})

test("Grok catalog refresh classifies timeouts as timeout failures", async () => {
  const token = accessToken({ sub: "timeout-account" })
  await Auth.set(GrokProvider.PROVIDER_ID, {
    type: "oauth",
    access: token,
    refresh: "refresh-timeout",
    expires: nowSeconds() + 60 * 60,
  })
  globalThis.fetch = asFetch(async () => {
    throw new DOMException("timed out", "TimeoutError")
  })

  const state = await ProviderCatalog.refresh(GrokProvider.PROVIDER_ID)
  expect(state.failure).toBe("timeout")
})
