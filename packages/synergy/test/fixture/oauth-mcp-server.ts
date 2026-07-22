import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

const SCOPE = "mcp:connect" as const
const TOOL_NAME = "fixture_ping" as const
const RESOURCE_NAME = "fixture_design" as const
const RESOURCE_URI = "fixture://figma/design" as const
const CLIENT_ID = "fixture-client"
const AUTHORIZATION_CODE = "fixture-authorization-code"
const ACCESS_TOKEN = "fixture-access-token"

export interface OAuthRegistrationObservation {
  readonly clientId: string
  readonly redirectUris: readonly string[]
  readonly scope?: string
  readonly tokenEndpointAuthMethod?: string
}

export interface OAuthAuthorizationObservation {
  readonly clientId: string
  readonly redirectUri: string
  readonly scope: string
  readonly state: string
  readonly resource: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: string
}

export interface OAuthTokenObservation {
  readonly clientId: string
  readonly code: string
  readonly redirectUri: string
  readonly resource: string
  readonly codeVerifier: string
}

export interface McpRequestObservation {
  readonly method: string
  readonly authorized: boolean
}

export interface OAuthMcpServerFixture extends AsyncDisposable {
  readonly url: string
  readonly scope: typeof SCOPE
  readonly toolName: typeof TOOL_NAME
  readonly resourceName: typeof RESOURCE_NAME
  readonly resourceUri: typeof RESOURCE_URI

  followAuthorization(authorizationUrl: string): Promise<{
    code: string
    state: string
    redirectUrl: string
  }>

  snapshot(): Readonly<{
    registrations: readonly OAuthRegistrationObservation[]
    authorizations: readonly OAuthAuthorizationObservation[]
    tokenExchanges: readonly OAuthTokenObservation[]
    mcpRequests: readonly McpRequestObservation[]
  }>
}

interface RegisteredClient {
  redirectUri: string
  scope: string
}

interface IssuedCode {
  redirectUri: string
  resource: string
  codeChallenge: string
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers })
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status)
}

function required(value: string | null, name: string): string {
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Buffer.from(digest).toString("base64url")
}

export function createOAuthMcpServerFixture(): OAuthMcpServerFixture {
  const registrations: OAuthRegistrationObservation[] = []
  const authorizations: OAuthAuthorizationObservation[] = []
  const tokenExchanges: OAuthTokenObservation[] = []
  const mcpRequests: McpRequestObservation[] = []
  const clients = new Map<string, RegisteredClient>()
  const codes = new Map<string, IssuedCode>()
  const mcpServers = new Set<McpServer>()

  let origin = ""
  let mcpUrl = ""
  let resourceMetadataUrl = ""

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json({
          resource: mcpUrl,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        })
      }

      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        })
      }

      if (request.method === "POST" && url.pathname === "/register") {
        const metadata = (await request.json()) as Record<string, unknown>
        const redirectUris = Array.isArray(metadata.redirect_uris)
          ? metadata.redirect_uris.filter((entry): entry is string => typeof entry === "string")
          : []
        const scope = typeof metadata.scope === "string" ? metadata.scope : undefined
        const tokenEndpointAuthMethod =
          typeof metadata.token_endpoint_auth_method === "string" ? metadata.token_endpoint_auth_method : undefined
        registrations.push({ clientId: CLIENT_ID, redirectUris, scope, tokenEndpointAuthMethod })

        if (redirectUris.length !== 1 || scope !== SCOPE || tokenEndpointAuthMethod !== "none") {
          return oauthError(
            "invalid_client_metadata",
            "Fixture requires one redirect URI, declaration scope, and public client",
          )
        }
        clients.set(CLIENT_ID, { redirectUri: redirectUris[0]!, scope })
        return json({ ...metadata, client_id: CLIENT_ID, client_id_issued_at: 1 }, 201)
      }

      if (request.method === "GET" && url.pathname === "/authorize") {
        try {
          const clientId = required(url.searchParams.get("client_id"), "client_id")
          const redirectUri = required(url.searchParams.get("redirect_uri"), "redirect_uri")
          const scope = required(url.searchParams.get("scope"), "scope")
          const state = required(url.searchParams.get("state"), "state")
          const resource = required(url.searchParams.get("resource"), "resource")
          const codeChallenge = required(url.searchParams.get("code_challenge"), "code_challenge")
          const codeChallengeMethod = required(url.searchParams.get("code_challenge_method"), "code_challenge_method")
          const client = clients.get(clientId)
          if (
            url.searchParams.get("response_type") !== "code" ||
            !client ||
            redirectUri !== client.redirectUri ||
            scope !== client.scope ||
            resource !== mcpUrl ||
            codeChallengeMethod !== "S256"
          ) {
            return oauthError("invalid_request", "Authorization parameters do not match registration")
          }
          authorizations.push({ clientId, redirectUri, scope, state, resource, codeChallenge, codeChallengeMethod })
          codes.set(AUTHORIZATION_CODE, { redirectUri, resource, codeChallenge })
          const redirect = new URL(redirectUri)
          redirect.searchParams.set("code", AUTHORIZATION_CODE)
          redirect.searchParams.set("state", state)
          return Response.redirect(redirect, 302)
        } catch (error) {
          return oauthError("invalid_request", error instanceof Error ? error.message : String(error))
        }
      }

      if (request.method === "POST" && url.pathname === "/token") {
        const form = await request.formData()
        const clientId = required(String(form.get("client_id") ?? ""), "client_id")
        const code = required(String(form.get("code") ?? ""), "code")
        const redirectUri = required(String(form.get("redirect_uri") ?? ""), "redirect_uri")
        const resource = required(String(form.get("resource") ?? ""), "resource")
        const codeVerifier = required(String(form.get("code_verifier") ?? ""), "code_verifier")
        tokenExchanges.push({ clientId, code, redirectUri, resource, codeVerifier })
        const issued = codes.get(code)
        if (
          form.get("grant_type") !== "authorization_code" ||
          clientId !== CLIENT_ID ||
          !issued ||
          issued.redirectUri !== redirectUri ||
          issued.resource !== resource ||
          (await sha256Base64Url(codeVerifier)) !== issued.codeChallenge
        ) {
          return oauthError("invalid_grant", "Token request failed exact PKCE and resource validation")
        }
        codes.delete(code)
        return json({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, scope: SCOPE })
      }

      if (url.pathname === "/mcp") {
        const authorized = request.headers.get("authorization") === `Bearer ${ACCESS_TOKEN}`
        mcpRequests.push({ method: request.method, authorized })
        if (!authorized) {
          return json({ error: "unauthorized" }, 401, {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          })
        }
        if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })

        const mcpServer = new McpServer({ name: "oauth-mcp-fixture", version: "1.0.0" })
        mcpServer.registerTool(TOOL_NAME, { description: "Deterministic fixture ping" }, async () => ({
          content: [{ type: "text", text: "fixture-pong" }],
        }))
        mcpServer.registerResource(
          RESOURCE_NAME,
          RESOURCE_URI,
          { title: "Fixture design", mimeType: "application/json" },
          async () => ({ contents: [{ uri: RESOURCE_URI, mimeType: "application/json", text: '{"fixture":true}' }] }),
        )
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
        mcpServers.add(mcpServer)
        await mcpServer.connect(transport)
        return transport.handleRequest(request, {
          authInfo: { token: ACCESS_TOKEN, clientId: CLIENT_ID, scopes: [SCOPE], resource: new URL(mcpUrl) },
        })
      }

      return new Response("Not found", { status: 404 })
    },
  })

  if (server.port === undefined) throw new Error("Failed to allocate OAuth MCP fixture port")
  origin = `http://127.0.0.1:${server.port}`
  mcpUrl = `${origin}/mcp`
  resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`

  return {
    url: mcpUrl,
    scope: SCOPE,
    toolName: TOOL_NAME,
    resourceName: RESOURCE_NAME,
    resourceUri: RESOURCE_URI,
    async followAuthorization(authorizationUrl) {
      const response = await fetch(authorizationUrl, { redirect: "manual" })
      if (response.status !== 302) throw new Error(`Authorization failed with HTTP ${response.status}`)
      const redirectUrl = required(response.headers.get("location"), "authorization redirect")
      const redirect = new URL(redirectUrl)
      return {
        code: required(redirect.searchParams.get("code"), "authorization code"),
        state: required(redirect.searchParams.get("state"), "authorization state"),
        redirectUrl,
      }
    },
    snapshot() {
      return Object.freeze({
        registrations: Object.freeze(
          registrations.map((entry) =>
            Object.freeze({ ...entry, redirectUris: Object.freeze([...entry.redirectUris]) }),
          ),
        ),
        authorizations: Object.freeze(authorizations.map((entry) => Object.freeze({ ...entry }))),
        tokenExchanges: Object.freeze(tokenExchanges.map((entry) => Object.freeze({ ...entry }))),
        mcpRequests: Object.freeze(mcpRequests.map((entry) => Object.freeze({ ...entry }))),
      })
    },
    async [Symbol.asyncDispose]() {
      await Promise.all([...mcpServers].map((mcpServer) => mcpServer.close().catch(() => undefined)))
      mcpServers.clear()
      server.stop(true)
    },
  }
}
