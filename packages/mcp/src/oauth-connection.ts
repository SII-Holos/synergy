import { auth, extractWWWAuthenticateParams, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { createFetchWithInit } from "@modelcontextprotocol/sdk/shared/transport.js"
import { McpAuth } from "./auth"
import { McpOAuthProvider, type McpOAuthCallbacks, type McpOAuthConfig, type McpOAuthMode } from "./oauth-provider"

type Challenge = Pick<ReturnType<typeof extractWWWAuthenticateParams>, "scope" | "resourceMetadataUrl">
type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>

// Provenance: MCP SDK 1.29 OAuthClientProvider and auth(), https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.29.0/src/client.
// Local adaptation: coordinate HTTP authentication per connection; the SDK owns discovery, grants and PKCE.
export class OAuthConnection {
  private readonly owner: McpAuth.Owner
  private readonly controller = new AbortController()
  private readonly signal: AbortSignal
  private active?: { key: string; promise: Promise<void> }
  private challenge: Challenge = {}

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly config: McpOAuthConfig,
    private readonly callbacks: McpOAuthCallbacks,
    private readonly mode: McpOAuthMode = "interactive",
    private readonly options: { headers?: HeadersInit; fetch?: Fetch; timeoutMs?: number } = {},
  ) {
    this.owner = McpAuth.owner(name)
    this.signal = AbortSignal.any([this.owner.signal, this.controller.signal])
  }

  private current(): void {
    this.signal.throwIfAborted()
    if (!this.owner.isCurrent() || this.callbacks.isCurrent?.() === false)
      throw new Error("MCP OAuth owner was superseded")
  }

  private async tokens(): Promise<McpAuth.Tokens | undefined> {
    this.current()
    const entry = await McpAuth.getForUrl(this.name, this.url)
    this.current()
    return entry?.tokens
  }

  private async authorize(challenge: Challenge, authorizationCode?: string, sentToken?: string): Promise<void> {
    const key = JSON.stringify([challenge.scope, challenge.resourceMetadataUrl?.href, authorizationCode !== undefined])
    while (this.active) {
      this.current()
      if (this.active.key === key) return this.active.promise
      await this.active.promise.catch(() => undefined)
    }
    this.current()
    this.challenge = challenge
    const promise = this.runAuth(challenge, authorizationCode, sentToken)
    const active = { key, promise }
    this.active = active
    try {
      await promise
    } finally {
      if (this.active === active) this.active = undefined
    }
  }

  private async runAuth(challenge: Challenge, authorizationCode?: string, sentToken?: string): Promise<void> {
    if (authorizationCode === undefined) {
      const tokens = await this.tokens()
      const scopes = new Set(tokens?.scope?.split(/\s+/))
      if (
        tokens &&
        tokens.accessToken !== sentToken &&
        (tokens.expiresAt === undefined || tokens.expiresAt > Date.now() / 1000) &&
        (!challenge.scope || challenge.scope.split(/\s+/).every((scope) => scopes.has(scope)))
      )
        return
    }
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.options.timeoutMs ?? 30_000)])
    const request = createFetchWithInit(this.options.fetch ?? fetch, { headers: this.options.headers })
    const provider = new McpOAuthProvider(
      this.name,
      this.url,
      this.config,
      {
        onRedirect: this.callbacks.onRedirect,
        isCurrent: () => !signal.aborted && this.owner.isCurrent() && this.callbacks.isCurrent?.() !== false,
      },
      this.mode,
    )
    const result = await auth(provider, {
      serverUrl: this.url,
      ...challenge,
      authorizationCode,
      fetchFn: async (input, init) => {
        this.current()
        signal.throwIfAborted()
        return request(input, {
          ...init,
          signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
        })
      },
    }).catch((error) => {
      signal.throwIfAborted()
      throw error
    })
    signal.throwIfAborted()
    this.current()
    if (result !== "AUTHORIZED") throw new UnauthorizedError()
  }

  readonly fetch: Fetch = async (input, init) => {
    this.current()
    const original = new Request(input, init)
    const signal = AbortSignal.any([original.signal, this.signal])
    const send = (request: Request, tokens: McpAuth.Tokens | undefined) => {
      signal.throwIfAborted()
      this.current()
      const headers = new Headers(this.options.headers)
      request.headers.forEach((value, name) => headers.set(name, value))
      if (tokens && !headers.has("authorization")) headers.set("authorization", `Bearer ${tokens.accessToken}`)
      return (this.options.fetch ?? fetch)(new Request(request, { headers, signal }))
    }
    const sent = await this.tokens()
    const response = await send(original.clone(), sent)
    const challenge = extractWWWAuthenticateParams(response)
    if (response.status !== 401 && !(response.status === 403 && challenge.error === "insufficient_scope"))
      return response
    await response.body?.cancel()
    signal.throwIfAborted()
    await this.wait(this.authorize(challenge, undefined, sent?.accessToken), signal)
    const retried = await send(original, await this.tokens())
    const repeated = extractWWWAuthenticateParams(retried)
    if (retried.status === 401 || (retried.status === 403 && repeated.error === "insufficient_scope")) {
      await retried.body?.cancel()
      throw new UnauthorizedError("MCP server rejected credentials after authentication")
    }
    return retried
  }

  private wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason)
      signal.addEventListener("abort", aborted, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
    })
  }

  finishAuth(code: string): Promise<void> {
    return this.authorize(this.challenge, code)
  }

  dispose(): void {
    this.controller.abort(new Error("MCP OAuth connection closed"))
  }
}
