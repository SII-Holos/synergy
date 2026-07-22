import { describe, expect, test, beforeAll, beforeEach, afterAll, afterEach, mock } from "bun:test"
import fs from "fs/promises"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH, getOAuthCallbackPort } from "../../src/mcp/oauth-provider"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { MCP } from "../../src/mcp"
import { PendingOAuth } from "../../src/mcp/pending-oauth"
import { Global } from "../../src/global"
import { McpSupervisor } from "../../src/mcp/supervisor"
import { startForPlugin } from "../../src/plugin/mcp"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util/log"

Log.init({ print: false })

let originalOAuthCallbackPort: string | undefined

async function reserveCallbackPort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok")
    },
  })
  const port = server.port
  if (port === undefined) {
    server.stop(true)
    throw new Error("Failed to reserve OAuth callback port")
  }
  server.stop(true)
  return port
}

beforeAll(async () => {
  originalOAuthCallbackPort = process.env.SYNERGY_OAUTH_CALLBACK_PORT
  process.env.SYNERGY_OAUTH_CALLBACK_PORT = String(await reserveCallbackPort())
})

afterAll(() => {
  if (originalOAuthCallbackPort === undefined) {
    delete process.env.SYNERGY_OAUTH_CALLBACK_PORT
    return
  }
  process.env.SYNERGY_OAUTH_CALLBACK_PORT = originalOAuthCallbackPort
})

function dispatchCallback(path: string): Response {
  return McpOAuthCallback.handleRequest(new Request(`http://127.0.0.1:${getOAuthCallbackPort()}${path}`))
}

describe.serial("McpOAuthProvider", () => {
  let backup: string | undefined

  beforeEach(async () => {
    McpAuth.invalidateCache()
    const file = Bun.file(Global.Path.authMcp)
    const exists = await file.exists()
    backup = exists ? await file.text() : undefined
    await fs.mkdir(new URL("..", `file://${Global.Path.authMcp}`).pathname, { recursive: true }).catch(() => {})
    await Bun.write(Global.Path.authMcp, "{}")
  })

  afterEach(async () => {
    if (backup !== undefined) {
      await Bun.write(Global.Path.authMcp, backup)
    } else {
      await Bun.write(Global.Path.authMcp, "{}")
    }
    McpAuth.invalidateCache()
  })

  function createProvider(
    mcpName = "test-server",
    serverUrl = "https://mcp.example.com",
    config?: { clientId?: string; clientSecret?: string; scope?: string },
    isCurrent?: () => boolean,
  ) {
    let capturedUrl: URL | undefined
    const provider = new McpOAuthProvider(mcpName, serverUrl, config ?? {}, {
      onRedirect: async (url) => {
        capturedUrl = url
      },
      isCurrent,
    })
    return { provider, getCapturedUrl: () => capturedUrl }
  }

  test("redirectUrl uses correct port and path", () => {
    const { provider } = createProvider()
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}`)
  })

  test("clientMetadata returns correct structure without clientSecret", () => {
    const { provider } = createProvider()
    const metadata = provider.clientMetadata

    expect(metadata.redirect_uris).toEqual([provider.redirectUrl])
    expect(metadata.client_name).toBe("Holos Synergy")
    expect(metadata.client_uri).toBe("https://synergy.holosai.io")
    expect(metadata.grant_types).toContain("authorization_code")
    expect(metadata.grant_types).toContain("refresh_token")
    expect(metadata.response_types).toEqual(["code"])
    expect(metadata.token_endpoint_auth_method).toBe("none")
  })

  test("clientMetadata uses client_secret_post when clientSecret is configured", () => {
    const { provider } = createProvider("test-server", "https://mcp.example.com", {
      clientId: "id",
      clientSecret: "secret",
    })
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post")
  })

  test("clientInformation returns config client when clientId is set", async () => {
    const { provider } = createProvider("test-server", "https://mcp.example.com", {
      clientId: "config-client",
      clientSecret: "config-secret",
    })
    const info = await provider.clientInformation()

    expect(info).toBeDefined()
    expect(info!.client_id).toBe("config-client")
    expect(info!.client_secret).toBe("config-secret")
  })

  test("clientInformation returns stored client when no config clientId", async () => {
    const { provider } = createProvider("stored-client-server", "https://mcp.example.com")
    await McpAuth.set(
      "stored-client-server",
      {
        clientInfo: {
          clientId: "stored-client",
          clientSecret: "stored-secret",
        },
      },
      "https://mcp.example.com",
    )

    const info = await provider.clientInformation()
    expect(info).toBeDefined()
    expect(info!.client_id).toBe("stored-client")
    expect(info!.client_secret).toBe("stored-secret")
  })

  test("clientInformation returns undefined when stored client URL differs", async () => {
    const { provider } = createProvider("url-diff-server", "https://mcp.example.com")
    await McpAuth.set(
      "url-diff-server",
      {
        clientInfo: { clientId: "stored-client" },
      },
      "https://different.example.com",
    )

    const info = await provider.clientInformation()
    expect(info).toBeUndefined()
  })

  test("clientInformation returns undefined when stored client secret expired", async () => {
    const { provider } = createProvider("expired-secret-server", "https://mcp.example.com")
    const pastExpiry = Date.now() / 1000 - 3600
    await McpAuth.set(
      "expired-secret-server",
      {
        clientInfo: {
          clientId: "stored-client",
          clientSecret: "old-secret",
          clientSecretExpiresAt: pastExpiry,
        },
      },
      "https://mcp.example.com",
    )

    const info = await provider.clientInformation()
    expect(info).toBeUndefined()
  })

  test("clientInformation returns stored client when secret is not expired", async () => {
    const { provider } = createProvider("valid-secret-server", "https://mcp.example.com")
    const futureExpiry = Date.now() / 1000 + 3600
    await McpAuth.set(
      "valid-secret-server",
      {
        clientInfo: {
          clientId: "stored-client",
          clientSecret: "valid-secret",
          clientSecretExpiresAt: futureExpiry,
        },
      },
      "https://mcp.example.com",
    )

    const info = await provider.clientInformation()
    expect(info).toBeDefined()
    expect(info!.client_id).toBe("stored-client")
  })

  test("clientInformation returns undefined when no stored or config client", async () => {
    const { provider } = createProvider("no-client-server", "https://mcp.example.com")
    const info = await provider.clientInformation()
    expect(info).toBeUndefined()
  })

  test("saveClientInformation persists client info", async () => {
    const { provider } = createProvider("save-client-server", "https://mcp.example.com")
    await provider.saveClientInformation({
      client_id: "dynamic-client",
      client_secret: "dynamic-secret",
      client_id_issued_at: 1234567890,
      client_secret_expires_at: 1234567890 + 86400,
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      token_endpoint_auth_method: "none",
    })

    const entry = await McpAuth.get("save-client-server")
    expect(entry!.clientInfo!.clientId).toBe("dynamic-client")
    expect(entry!.clientInfo!.clientSecret).toBe("dynamic-secret")
    expect(entry!.clientInfo!.clientIdIssuedAt).toBe(1234567890)
    expect(entry!.serverUrl).toBe("https://mcp.example.com")
  })

  test("tokens returns undefined when no stored tokens", async () => {
    const { provider } = createProvider("no-tokens-server", "https://mcp.example.com")
    const tokens = await provider.tokens()
    expect(tokens).toBeUndefined()
  })

  test("tokens returns undefined when stored URL differs", async () => {
    const { provider } = createProvider("token-url-diff-server", "https://mcp.example.com")
    await McpAuth.set(
      "token-url-diff-server",
      {
        tokens: { accessToken: "tok" },
      },
      "https://different.example.com",
    )

    const tokens = await provider.tokens()
    expect(tokens).toBeUndefined()
  })

  test("tokens returns stored tokens with correct fields", async () => {
    const { provider } = createProvider("tokens-server", "https://mcp.example.com")
    const futureExpiry = Date.now() / 1000 + 3600
    await McpAuth.set(
      "tokens-server",
      {
        tokens: {
          accessToken: "access-tok",
          refreshToken: "refresh-tok",
          expiresAt: futureExpiry,
          scope: "read write",
        },
      },
      "https://mcp.example.com",
    )

    const tokens = await provider.tokens()
    expect(tokens).toBeDefined()
    expect(tokens!.access_token).toBe("access-tok")
    expect(tokens!.token_type).toBe("Bearer")
    expect(tokens!.refresh_token).toBe("refresh-tok")
    expect(tokens!.scope).toBe("read write")
    expect(tokens!.expires_in).toBeGreaterThan(0)
  })

  test("tokens computes expires_in correctly", async () => {
    const { provider } = createProvider("expires-server", "https://mcp.example.com")
    const expiresIn = 3600
    const expiresAt = Date.now() / 1000 + expiresIn
    await McpAuth.set(
      "expires-server",
      {
        tokens: { accessToken: "tok", expiresAt },
      },
      "https://mcp.example.com",
    )

    const tokens = await provider.tokens()
    expect(tokens!.expires_in).toBeLessThanOrEqual(expiresIn)
    expect(tokens!.expires_in).toBeGreaterThan(expiresIn - 5)
  })

  test("tokens returns undefined expires_in when no expiresAt", async () => {
    const { provider } = createProvider("no-expiry-server", "https://mcp.example.com")
    await McpAuth.set(
      "no-expiry-server",
      {
        tokens: { accessToken: "tok" },
      },
      "https://mcp.example.com",
    )

    const tokens = await provider.tokens()
    expect(tokens!.expires_in).toBeUndefined()
  })

  test("saveTokens persists tokens", async () => {
    const { provider } = createProvider("save-tokens-server", "https://mcp.example.com")
    await provider.saveTokens({
      access_token: "new-access",
      token_type: "Bearer",
      refresh_token: "new-refresh",
      expires_in: 7200,
      scope: "read",
    })

    const entry = await McpAuth.get("save-tokens-server")
    expect(entry!.tokens!.accessToken).toBe("new-access")
    expect(entry!.tokens!.refreshToken).toBe("new-refresh")
    expect(entry!.tokens!.scope).toBe("read")
    expect(entry!.tokens!.expiresAt).toBeGreaterThan(Date.now() / 1000)
    expect(entry!.serverUrl).toBe("https://mcp.example.com")
  })

  test("stale same-name provider cannot overwrite newer tokens or client registration", async () => {
    const name = "replaced-provider"
    let currentIdentity = "stale"
    const stale = createProvider(name, "https://old.example.com/mcp", {}, () => currentIdentity === "stale").provider
    const current = createProvider(
      name,
      "https://new.example.com/mcp",
      {},
      () => currentIdentity === "current",
    ).provider
    currentIdentity = "current"
    await current.saveClientInformation({
      client_id: "current-client",
      client_secret: "current-client-secret",
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      token_endpoint_auth_method: "none",
    })
    await current.saveTokens({
      access_token: "current-access-token",
      token_type: "Bearer",
      refresh_token: "current-refresh-token",
    })

    await stale.saveClientInformation({
      client_id: "stale-client",
      client_secret: "stale-client-secret",
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      token_endpoint_auth_method: "none",
    })
    await stale.saveTokens({
      access_token: "stale-access-token",
      token_type: "Bearer",
      refresh_token: "stale-refresh-token",
    })

    expect(await McpAuth.get(name)).toMatchObject({
      serverUrl: "https://new.example.com/mcp",
      clientInfo: { clientId: "current-client", clientSecret: "current-client-secret" },
      tokens: { accessToken: "current-access-token", refreshToken: "current-refresh-token" },
    })
  })

  test("redirectToAuthorization calls onRedirect callback", async () => {
    let redirectedUrl: URL | undefined
    const provider = new McpOAuthProvider(
      "redirect-server",
      "https://mcp.example.com",
      {},
      {
        onRedirect: async (url) => {
          redirectedUrl = url
        },
      },
    )

    const authUrl = new URL("https://auth.example.com/authorize?client_id=abc")
    await provider.redirectToAuthorization(authUrl)

    expect(redirectedUrl).toBeDefined()
    expect(redirectedUrl!.toString()).toBe(authUrl.toString())
  })

  test("saveCodeVerifier persists verifier", async () => {
    const { provider } = createProvider("verifier-server", "https://mcp.example.com")
    await provider.saveCodeVerifier("my-verifier")

    const entry = await McpAuth.get("verifier-server")
    expect(entry!.codeVerifier).toBe("my-verifier")
  })

  test("codeVerifier returns stored verifier", async () => {
    const { provider } = createProvider("get-verifier-server", "https://mcp.example.com")
    await provider.saveCodeVerifier("my-verifier")

    const verifier = await provider.codeVerifier()
    expect(verifier).toBe("my-verifier")
  })

  test("codeVerifier throws when no verifier saved", async () => {
    const { provider } = createProvider("no-verifier-server", "https://mcp.example.com")
    await expect(provider.codeVerifier()).rejects.toThrow("No code verifier saved for MCP server: no-verifier-server")
  })

  test("saveState persists state", async () => {
    const { provider } = createProvider("state-server", "https://mcp.example.com")
    await provider.saveState("my-state")

    const entry = await McpAuth.get("state-server")
    expect(entry!.oauthState).toBe("my-state")
  })

  test("state returns stored state", async () => {
    const { provider } = createProvider("get-state-server", "https://mcp.example.com")
    await provider.saveState("my-state")

    const state = await provider.state()
    expect(state).toBe("my-state")
  })

  test("state creates and persists state when none is saved", async () => {
    const { provider } = createProvider("no-state-server", "https://mcp.example.com")
    const state = await provider.state()

    expect(state).not.toBe("")
    expect((await McpAuth.get("no-state-server"))?.oauthState).toBe(state)
  })

  test("stale pending owner cleanup preserves a newer verifier and OAuth state", async () => {
    const name = "replaced-pending-owner"
    const staleIdentity = "plugin:stale"
    const currentIdentity = "plugin:current"
    const staleVerifier = "stale-verifier"
    const staleState = "stale-state"
    await McpAuth.set(name, { codeVerifier: staleVerifier, oauthState: staleState })
    await PendingOAuth.register(name, {
      identity: staleIdentity,
      client: { close: async () => {} },
      transport: { finishAuth: async () => {} },
      onDispose: async () => {
        await Promise.all([McpAuth.clearCodeVerifier(name, staleVerifier), McpAuth.clearOAuthState(name, staleState)])
      },
    })
    await McpAuth.set(name, { codeVerifier: "current-verifier", oauthState: "current-state" })

    await PendingOAuth.register(name, {
      identity: currentIdentity,
      client: { close: async () => {} },
      transport: { finishAuth: async () => {} },
    })

    expect(PendingOAuth.get(name)?.identity).toBe(currentIdentity)
    expect(await McpAuth.get(name)).toMatchObject({
      codeVerifier: "current-verifier",
      oauthState: "current-state",
    })
  })
})

describe.serial("McpOAuthCallback", () => {
  afterEach(async () => {
    await McpOAuthCallback.stop()
  })

  test("isRunning returns false initially", () => {
    expect(McpOAuthCallback.isRunning()).toBe(false)
  })

  test("isRunning returns true after ensureRunning", async () => {
    await McpOAuthCallback.ensureRunning()
    expect(McpOAuthCallback.isRunning()).toBe(true)
  })

  test("ensureRunning is idempotent", async () => {
    await McpOAuthCallback.ensureRunning()
    await McpOAuthCallback.ensureRunning()
    expect(McpOAuthCallback.isRunning()).toBe(true)
  })

  test("stop sets isRunning to false", async () => {
    await McpOAuthCallback.ensureRunning()
    expect(McpOAuthCallback.isRunning()).toBe(true)

    await McpOAuthCallback.stop()
    expect(McpOAuthCallback.isRunning()).toBe(false)
  })

  test("waitForCallback resolves with code on successful callback", async () => {
    const oauthState = "test-state-123"
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    const response = dispatchCallback(`${OAUTH_CALLBACK_PATH}?code=auth-code-456&state=${oauthState}`)

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("Authorization Successful")

    const code = await callbackPromise
    expect(code).toBe("auth-code-456")
  })

  test("callback rejects with error from OAuth provider", async () => {
    const oauthState = "error-state-789"
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    const response = dispatchCallback(
      `${OAUTH_CALLBACK_PATH}?error=access_denied&error_description=User+denied+access&state=${oauthState}`,
    )

    await Promise.allSettled([
      (async () => {
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("Authorization Failed")
      })(),
      expect(callbackPromise).rejects.toThrow("User denied access"),
    ])
  })

  test("callback escapes provider errors before rendering HTML", async () => {
    const oauthState = "escaped-error-state"
    const errorDescription = `<script>alert("xss")</script> & denied`
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)
    const response = dispatchCallback(
      `${OAUTH_CALLBACK_PATH}?error=access_denied&error_description=${encodeURIComponent(errorDescription)}&state=${oauthState}`,
    )

    await Promise.all([
      (async () => {
        const body = await response.text()
        expect(body).not.toContain("<script>alert")
        expect(body).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; denied")
      })(),
      expect(callbackPromise).rejects.toThrow(errorDescription),
    ])
  })

  test("callback rejects with error code when no description", async () => {
    const oauthState = "error-state-no-desc"
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    const response = dispatchCallback(`${OAUTH_CALLBACK_PATH}?error=server_error&state=${oauthState}`)

    await Promise.allSettled([response.text(), expect(callbackPromise).rejects.toThrow("server_error")])
  })

  test("callback returns 400 when state parameter is missing", async () => {
    const response = dispatchCallback(`${OAUTH_CALLBACK_PATH}?code=some-code`)

    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain("Missing required state parameter")
  })

  test("callback returns 400 for valid state but missing code", async () => {
    const oauthState = "no-code-state"
    McpOAuthCallback.waitForCallback(oauthState).catch(() => {})

    const response = dispatchCallback(`${OAUTH_CALLBACK_PATH}?state=${oauthState}`)

    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain("No authorization code provided")
  })

  test("callback returns 400 for invalid state parameter", async () => {
    const response = dispatchCallback(`${OAUTH_CALLBACK_PATH}?code=abc&state=unknown-state`)

    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain("Invalid or expired state parameter")
  })

  test("callback returns 404 for wrong path", async () => {
    const response = dispatchCallback("/wrong/path")

    expect(response.status).toBe(404)
  })

  test("cancelPending rejects the callback registered for an MCP server", async () => {
    const callbackPromise = McpOAuthCallback.waitForCallback("cancel-state", "demo-server")

    McpOAuthCallback.cancelPending("demo-server")

    await expect(callbackPromise).rejects.toThrow("Authorization cancelled")
  })

  test("cancelling one MCP server leaves other callbacks pending", async () => {
    const first = McpOAuthCallback.waitForCallback("first-state", "first-server")
    const second = McpOAuthCallback.waitForCallback("second-state", "second-server")

    McpOAuthCallback.cancelPending("first-server")
    const response = dispatchCallback(`${OAUTH_CALLBACK_PATH}?code=second-code&state=second-state`)

    await expect(first).rejects.toThrow("Authorization cancelled")
    expect(await second).toBe("second-code")
    expect(response.status).toBe(200)
  })

  test("finishAuth failure closes the pending OAuth owner", async () => {
    const close = mock(async () => {})
    await PendingOAuth.register("failed-server", {
      client: { close },
      transport: {
        finishAuth: async () => {
          throw new Error("token exchange failed")
        },
      },
      identity: "failed-server:test",
    })

    const status = await MCP.finishAuth("failed-server", "invalid-code")

    expect(status).toEqual({ status: "failed", error: "token exchange failed" })
    expect(close).toHaveBeenCalledTimes(1)
    expect(PendingOAuth.get("failed-server")).toBeUndefined()
  })

  test("finishAuth rejects a plugin server replaced during token exchange", async () => {
    await using tmp = await tmpdir({ config: {} })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const name = "demo-plugin::oauth"
        const declaration = {
          oauth: {
            type: "remote" as const,
            url: "https://plugin.example.com/mcp",
            oauth: { scope: "mcp:connect" },
            startup: "manual" as const,
          },
        }
        await startForPlugin("demo-plugin", declaration)
        const resolved = await MCP.resolveServer(name)
        expect(resolved).toBeDefined()

        let exchangeStarted!: () => void
        const started = new Promise<void>((resolve) => {
          exchangeStarted = resolve
        })
        let completeExchange!: () => void
        const exchange = new Promise<void>((resolve) => {
          completeExchange = resolve
        })
        const close = mock(async () => {})
        await PendingOAuth.register(name, {
          client: { close },
          transport: {
            finishAuth: async () => {
              exchangeStarted()
              await exchange
            },
          },
          identity: resolved!.identity,
        })

        const completion = MCP.finishAuth(name, "authorization-code")
        await started
        await startForPlugin("demo-plugin", declaration)
        completeExchange()

        expect(await completion).toEqual({
          status: "failed",
          error: "MCP server changed while OAuth was in progress; restart authentication",
        })
        expect(McpSupervisor.get(name)).toBeDefined()
        expect(PendingOAuth.get(name)).toBeUndefined()
      },
    })
  })
  test("MCP stop shuts down the OAuth callback server", async () => {
    await McpOAuthCallback.ensureRunning()

    await MCP.stop()

    expect(McpOAuthCallback.isRunning()).toBe(false)
  })

  test("stop rejects all pending auths", async () => {
    await McpOAuthCallback.ensureRunning()

    const promise1 = McpOAuthCallback.waitForCallback("stop-state-1")
    const promise2 = McpOAuthCallback.waitForCallback("stop-state-2")

    await McpOAuthCallback.stop()

    await expect(promise1).rejects.toThrow("OAuth callback server stopped")
    await expect(promise2).rejects.toThrow("OAuth callback server stopped")
  })
})
