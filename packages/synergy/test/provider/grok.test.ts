import { afterEach, beforeEach, expect, test } from "bun:test"
import { Auth } from "../../src/provider/api-key"
import { GrokProvider } from "../../src/provider/grok"
import { ProviderCatalog } from "../../src/provider/catalog"
import { Provider } from "../../src/provider/provider"

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

function accessToken(input?: { exp?: number }) {
  return makeJWT({ exp: input?.exp ?? nowSeconds() + 60 * 60 })
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
  )
  expect(token.access).toBe(issuedAccess)
  expect(polls).toBe(3)
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
