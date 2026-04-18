import { describe, expect, test, beforeAll, beforeEach, afterAll, afterEach } from "bun:test"
import fs from "fs/promises"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH, getOAuthCallbackPort } from "../../src/mcp/oauth-provider"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { Global } from "../../src/global"
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

describe("McpOAuthProvider", () => {
  let backup: string | undefined

  beforeEach(async () => {
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
  })

  function createProvider(
    mcpName = "test-server",
    serverUrl = "https://mcp.example.com",
    config?: { clientId?: string; clientSecret?: string; scope?: string },
  ) {
    let capturedUrl: URL | undefined
    const provider = new McpOAuthProvider(mcpName, serverUrl, config ?? {}, {
      onRedirect: async (url) => {
        capturedUrl = url
      },
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

  test("state throws when no state saved", async () => {
    const { provider } = createProvider("no-state-server", "https://mcp.example.com")
    await expect(provider.state()).rejects.toThrow("No OAuth state saved for MCP server: no-state-server")
  })
})

describe("McpOAuthCallback", () => {
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
    await McpOAuthCallback.ensureRunning()

    const oauthState = "test-state-123"
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    const response = await fetch(
      `http://127.0.0.1:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}?code=auth-code-456&state=${oauthState}`,
    )

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("Authorization Successful")

    const code = await callbackPromise
    expect(code).toBe("auth-code-456")
  })

  test("callback rejects with error from OAuth provider", async () => {
    await McpOAuthCallback.ensureRunning()

    const oauthState = "error-state-789"
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    const fetchPromise = fetch(
      `http://127.0.0.1:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}?error=access_denied&error_description=User+denied+access&state=${oauthState}`,
    )

    await Promise.allSettled([
      fetchPromise.then(async (r) => {
        expect(r.status).toBe(200)
        expect(await r.text()).toContain("Authorization Failed")
      }),
      expect(callbackPromise).rejects.toThrow("User denied access"),
    ])
  })

  test("callback rejects with error code when no description", async () => {
    await McpOAuthCallback.ensureRunning()

    const oauthState = "error-state-no-desc"
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    const fetchPromise = fetch(
      `http://127.0.0.1:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}?error=server_error&state=${oauthState}`,
    )

    await Promise.allSettled([fetchPromise, expect(callbackPromise).rejects.toThrow("server_error")])
  })

  test("callback returns 400 when state parameter is missing", async () => {
    await McpOAuthCallback.ensureRunning()

    const response = await fetch(`http://127.0.0.1:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}?code=some-code`)

    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain("Missing required state parameter")
  })

  test("callback returns 400 for valid state but missing code", async () => {
    await McpOAuthCallback.ensureRunning()

    const oauthState = "no-code-state"
    McpOAuthCallback.waitForCallback(oauthState).catch(() => {})

    const response = await fetch(`http://127.0.0.1:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}?state=${oauthState}`)

    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain("No authorization code provided")
  })

  test("callback returns 400 for invalid state parameter", async () => {
    await McpOAuthCallback.ensureRunning()

    const response = await fetch(
      `http://127.0.0.1:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}?code=abc&state=unknown-state`,
    )

    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain("Invalid or expired state parameter")
  })

  test("callback returns 404 for wrong path", async () => {
    await McpOAuthCallback.ensureRunning()

    const response = await fetch(`http://127.0.0.1:${getOAuthCallbackPort()}/wrong/path`)

    expect(response.status).toBe(404)
  })

  test("cancelPending rejects the waiting promise", async () => {
    await McpOAuthCallback.ensureRunning()

    const oauthState = "cancel-state"
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    McpOAuthCallback.cancelPending(oauthState)

    await expect(callbackPromise).rejects.toThrow("Authorization cancelled")
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
