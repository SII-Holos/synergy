import { Auth } from "./api-key"
import { AccountUsage } from "./usage"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import type { AuthOuathResult } from "@ericsanchezok/synergy-plugin/auth"
import z from "zod"
import { ProviderAuthRecovery } from "./auth-recovery"
import type { ProviderProfile } from "./profile"

export namespace AnthropicOAuthProvider {
  export const PROVIDER_ID = "anthropic"
  export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
  export const OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
  export const OAUTH_SCOPES = "org:create_api_key user:profile user:inference"
  export const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
  export const OAUTH_TOKEN_URLS = [
    "https://platform.claude.com/v1/oauth/token",
    "https://console.anthropic.com/v1/oauth/token",
  ] as const
  export const AUTH_REFRESH_SKEW_SECONDS = 5 * 60

  type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export const AuthError = NamedError.create(
    "AnthropicOAuthError",
    z.object({
      providerID: z.literal(PROVIDER_ID),
      code: z.string(),
      message: z.string(),
      reloginRequired: z.boolean(),
    }),
  )

  function nowSeconds() {
    return Math.floor(Date.now() / 1000)
  }

  function base64URL(input: ArrayBuffer | Uint8Array) {
    return Buffer.from(input instanceof Uint8Array ? input : new Uint8Array(input)).toString("base64url")
  }

  async function sha256(input: string) {
    return base64URL(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)))
  }

  function randomToken(bytes = 32) {
    return base64URL(crypto.getRandomValues(new Uint8Array(bytes)))
  }

  async function safeJson(response: Response): Promise<Record<string, any>> {
    try {
      const value = await response.json()
      return value && typeof value === "object" ? value : {}
    } catch {
      return {}
    }
  }

  function toExpires(payload: Record<string, any>) {
    const expiresIn = Number(payload.expires_in)
    return nowSeconds() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600)
  }

  function oauthHeaders() {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "claude-cli/2.1.0 (external, cli)",
    }
  }

  async function postToken(body: Record<string, string>, fetchFn: FetchLike) {
    let lastPayload: Record<string, any> = {}
    let lastStatus = 0
    for (const endpoint of OAUTH_TOKEN_URLS) {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: oauthHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      }).catch((error) => {
        lastPayload = { message: String(error) }
        return undefined
      })
      if (!response) continue
      lastStatus = response.status
      lastPayload = await safeJson(response)
      if (response.ok) return lastPayload
      if (response.status !== 404) break
    }
    const code = String(lastPayload.error ?? lastPayload.type ?? "anthropic_oauth_failed")
    throw new AuthError({
      providerID: PROVIDER_ID,
      code,
      message: String(
        lastPayload.error_description ?? lastPayload.message ?? `Anthropic OAuth failed with status ${lastStatus}.`,
      ),
      reloginRequired: ["invalid_grant", "invalid_token", "refresh_token_reused"].includes(code) || lastStatus === 401,
    })
  }

  export async function authorizeOAuth(fetchFn: FetchLike = fetch): Promise<AuthOuathResult> {
    const verifier = randomToken(32)
    const state = randomToken(32)
    const params = new URLSearchParams({
      code: "true",
      client_id: OAUTH_CLIENT_ID,
      response_type: "code",
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      code_challenge: await sha256(verifier),
      code_challenge_method: "S256",
      state,
    })
    return {
      url: `${OAUTH_AUTHORIZE_URL}?${params}`,
      method: "code",
      instructions: "Paste the Claude authorization code, including the #state suffix.",
      async callback(rawCode: string) {
        const [code, returnedState] = rawCode.trim().split("#")
        if (!code || returnedState !== state) return { type: "failed" }
        try {
          const payload = await postToken(
            {
              grant_type: "authorization_code",
              client_id: OAUTH_CLIENT_ID,
              code,
              state: returnedState,
              redirect_uri: OAUTH_REDIRECT_URI,
              code_verifier: verifier,
            },
            fetchFn,
          )
          if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") {
            return { type: "failed" }
          }
          return {
            type: "success",
            access: payload.access_token,
            refresh: payload.refresh_token,
            expires: toExpires(payload),
            provider: PROVIDER_ID,
          }
        } catch {
          return { type: "failed" }
        }
      },
    }
  }

  export async function refreshOAuth(auth: z.infer<typeof Auth.Oauth>, fetchFn: FetchLike = fetch) {
    const payload = await postToken(
      {
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: auth.refresh,
      },
      fetchFn,
    )
    if (typeof payload.access_token !== "string") {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "missing_access_token",
        message: "Anthropic OAuth refresh response was missing access_token.",
        reloginRequired: true,
      })
    }
    return {
      access: payload.access_token,
      refresh: typeof payload.refresh_token === "string" ? payload.refresh_token : auth.refresh,
      expires: toExpires(payload),
    }
  }

  export async function resolveToken(options?: { allowMissing?: boolean; fetch?: FetchLike }) {
    const selected = await Auth.select(PROVIDER_ID)
    const auth = selected?.auth
    if (!selected || !auth || auth.type !== "oauth") {
      if (options?.allowMissing) return undefined
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "anthropic_oauth_missing",
        message: "No Anthropic OAuth credentials stored.",
        reloginRequired: true,
      })
    }
    if (auth.expires > nowSeconds() + AUTH_REFRESH_SKEW_SECONDS) return auth.access
    try {
      return await Auth.withLock(`${PROVIDER_ID}:oauth-refresh`, async () => {
        const latestSelected = await Auth.select(PROVIDER_ID)
        const latest = latestSelected?.auth
        if (latest?.type === "oauth" && latest.expires > nowSeconds() + AUTH_REFRESH_SKEW_SECONDS) return latest.access
        const refreshed = await refreshOAuth(latest?.type === "oauth" ? latest : auth, options?.fetch)
        await Auth.replaceSelectedCredential(
          PROVIDER_ID,
          {
            type: "oauth",
            access: refreshed.access,
            refresh: refreshed.refresh,
            expires: refreshed.expires,
          },
          { credentialID: latestSelected?.credentialID ?? selected.credentialID },
        )
        return refreshed.access
      })
    } catch (error) {
      if (AuthError.isInstance(error) && error.data.reloginRequired) {
        await Auth.markDead(PROVIDER_ID, error.data.code).catch(() => {})
        if (options?.allowMissing) return undefined
      }
      throw error
    }
  }

  export function requestHeaders(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta":
        "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      "User-Agent": "claude-cli/2.1.0 (external, cli)",
      "x-app": "cli",
    }
  }

  export async function anthropicFetch(input: RequestInfo | URL, init?: RequestInit) {
    return ProviderAuthRecovery.execute({
      providerID: PROVIDER_ID,
      request: async () => {
        const token = await resolveToken()
        const headers = new Headers(init?.headers)
        headers.delete("x-api-key")
        headers.delete("X-Api-Key")
        for (const [key, value] of Object.entries(requestHeaders(token!))) headers.set(key, value)
        return fetch(input, { ...init, headers })
      },
      refresh: refreshAuth,
      classify: classifyError,
    })
  }

  export async function fetchUsage(fetchFn: FetchLike = fetch): Promise<AccountUsage.Snapshot> {
    const token = await resolveToken({ allowMissing: true, fetch: fetchFn })
    if (!token) {
      return AccountUsage.unavailable(
        PROVIDER_ID,
        "Anthropic account limits are only available for OAuth-backed Claude accounts.",
      )
    }
    const response = await ProviderAuthRecovery.execute({
      providerID: PROVIDER_ID,
      request: async () => {
        const current = await resolveToken({ allowMissing: true, fetch: fetchFn })
        if (!current) return new Response(null, { status: 401 })
        return fetchFn("https://api.anthropic.com/api/oauth/usage", {
          headers: requestHeaders(current),
          signal: AbortSignal.timeout(15_000),
        })
      },
      refresh: (auth) => refreshAuth(auth, fetchFn),
      classify: classifyError,
      throwOnActionRequired: false,
    })
    if (!response.ok) {
      const failure = classifyError({ status: response.status, body: await safeJson(response.clone()) })
      if (failure?.reloginRequired) {
        return AccountUsage.error(PROVIDER_ID, "Anthropic rejected these credentials. Reconnect to restore usage.", {
          reloginRequired: true,
        })
      }
      if (failure?.exhausted) {
        return AccountUsage.unavailable(PROVIDER_ID, "Anthropic usage is temporarily rate limited.")
      }
      return AccountUsage.error(PROVIDER_ID, "Anthropic usage is temporarily unavailable.")
    }
    const payload = await safeJson(response)
    const windows = [
      ["five_hour", "Current session"],
      ["seven_day", "Current week"],
      ["seven_day_opus", "Opus week"],
      ["seven_day_sonnet", "Sonnet week"],
    ]
      .map(([key, label]) => {
        const value = payload[key]?.utilization
        const used = typeof value === "number" && value <= 1 ? value * 100 : value
        return AccountUsage.percentWindow({ label, usedPercent: used, resetAt: payload[key]?.resets_at })
      })
      .filter((item): item is AccountUsage.Window => !!item)
    const details: string[] = []
    const extra = payload.extra_usage ?? {}
    if (extra.is_enabled && typeof extra.used_credits === "number" && typeof extra.monthly_limit === "number") {
      details.push(
        `Extra usage: ${extra.used_credits.toFixed(2)} / ${extra.monthly_limit.toFixed(2)} ${extra.currency ?? "USD"}`,
      )
    }
    return {
      providerID: PROVIDER_ID,
      status: "available",
      source: "oauth_usage_api",
      fetchedAt: new Date().toISOString(),
      windows,
      details,
    }
  }

  export async function refreshAuth(auth: Auth.Info, fetchFn: FetchLike = fetch): Promise<Auth.Info | undefined> {
    if (auth.type !== "oauth") return undefined
    const refreshed = await refreshOAuth(auth, fetchFn)
    return {
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
    }
  }

  export function classifyError(input: {
    status?: number
    body?: unknown
  }): ProviderProfile.ClassifiedError | undefined {
    const payload = input.body && typeof input.body === "object" ? (input.body as Record<string, any>) : {}
    const type = String(payload.type ?? payload.error?.type ?? payload.error ?? "")
    if (input.status === 429) return { code: type || "rate_limited", retryable: true, exhausted: true }
    if (input.status === 401 || ["authentication_error", "invalid_token"].includes(type)) {
      return { code: type || "credential_rejected", retryable: false, reloginRequired: true }
    }
    return undefined
  }
}
