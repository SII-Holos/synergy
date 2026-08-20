import { Auth } from "@/provider/api-key"
import { Log } from "@/util/log"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import type { AuthOuathResult } from "@ericsanchezok/synergy-plugin/auth"
import z from "zod"
import { ProviderAuthRecovery } from "./auth-recovery"
import type { ProviderProfile } from "./profile"
import { AccountUsage } from "./usage"

export namespace GrokProvider {
  const log = Log.create({ service: "provider.grok" })

  export const PROVIDER_ID = "grok"
  export const BASE_URL = "https://api.x.ai/v1"
  export const OAUTH_ISSUER = "https://auth.x.ai"
  export const OAUTH_DEVICE_URL = `${OAUTH_ISSUER}/oauth2/device/code`
  export const OAUTH_TOKEN_URL = `${OAUTH_ISSUER}/oauth2/token`

  // Public OAuth client used by the official Grok CLI flow. xAI does not offer
  // third-party OAuth client registration; community integrations reuse this
  // public client (no secret; token endpoint auth method "none"). Verified via
  // the official install script (OIDC_SCOPE="https://auth.x.ai::b1a00492-...")
  // and multiple independent community implementations. Not a secret.
  export const OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
  export const OAUTH_SCOPES = "openid profile email offline_access grok-cli:access api:access"
  export const AUTH_REFRESH_SKEW_SECONDS = 5 * 60

  export const DEFAULT_MODEL_IDS = ["grok-4.6", "grok-4.5", "grok-4.3"] as const

  type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export const AuthError = NamedError.create(
    "GrokAuthError",
    z.object({
      providerID: z.string(),
      code: z.string(),
      message: z.string(),
      reloginRequired: z.boolean(),
    }),
  )

  export const RateLimitError = NamedError.create(
    "GrokRateLimitError",
    z.object({
      providerID: z.string(),
      code: z.literal("rate_limited"),
      message: z.string(),
      retryAfterSeconds: z.number().optional(),
    }),
  )

  export type TokenPayload = {
    access: string
    refresh: string
    expires: number
  }

  type OAuthAuth = z.infer<typeof Auth.Oauth>

  export type DeviceCode = {
    deviceCode: string
    userCode: string
    verificationURI: string
    intervalSeconds: number
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000)
  }

  function parseJWTClaims(token: string): Record<string, any> | undefined {
    try {
      const payload = token.split(".")[1]
      if (!payload) return undefined
      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
      return JSON.parse(Buffer.from(padded, "base64").toString("utf8"))
    } catch {
      return undefined
    }
  }

  function accessTokenExpiresAt(token: string): number | undefined {
    const exp = parseJWTClaims(token)?.exp
    return typeof exp === "number" ? exp : undefined
  }

  // Stable account identity for live-catalog snapshot isolation. The default
  // credential identity includes the refresh token, which xAI rotates (and
  // revokes the previous one) on every refresh; deriving the identity from the
  // JWT subject keeps the catalog snapshot stable across token rotation. Falls
  // back to the default credential identity when neither claim is present.
  export function grokAccountID(token: string): string | undefined {
    const claims = parseJWTClaims(token)
    if (!claims) return undefined
    const sub = claims.sub
    if (typeof sub === "string" && sub) return `sub:${sub}`
    const email = claims.email
    if (typeof email === "string" && email) return `email:${email}`
    return undefined
  }

  function isAccessTokenExpiring(token: string, skewSeconds = AUTH_REFRESH_SKEW_SECONDS) {
    const exp = accessTokenExpiresAt(token)
    if (!exp) return false
    return exp <= nowSeconds() + skewSeconds
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

  function parseRetryAfterSeconds(headers: Headers) {
    const raw = headers.get("retry-after") ?? headers.get("retry-after-ms")
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) return undefined
    return raw === headers.get("retry-after-ms") ? Math.ceil(value / 1000) : Math.ceil(value)
  }

  async function safeJson(response: Response): Promise<Record<string, any>> {
    try {
      const value = await response.json()
      return value && typeof value === "object" ? value : {}
    } catch {
      return {}
    }
  }

  function errorCode(payload: Record<string, any>) {
    const error = payload.error
    if (typeof error === "string") return error
    if (error && typeof error === "object") {
      const nested = error.code ?? error.type
      if (typeof nested === "string" && nested) return nested
    }
    return undefined
  }

  function errorMessage(payload: Record<string, any>, fallback: string) {
    const error = payload.error
    if (error && typeof error === "object" && typeof error.message === "string") return error.message
    if (typeof payload.error_description === "string") return payload.error_description
    if (typeof payload.message === "string") return payload.message
    return fallback
  }

  function toTokenPayload(payload: Record<string, any>, fallbackRefresh?: string): TokenPayload {
    const access = payload.access_token
    if (typeof access !== "string" || !access.trim()) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "missing_access_token",
        message: "Grok token response was missing access_token.",
        reloginRequired: true,
      })
    }
    const refresh =
      typeof payload.refresh_token === "string" && payload.refresh_token.trim()
        ? payload.refresh_token
        : fallbackRefresh
    if (typeof refresh !== "string" || !refresh.trim()) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "missing_refresh_token",
        message: "Grok token response was missing refresh_token.",
        reloginRequired: true,
      })
    }
    const expires =
      typeof payload.expires_in === "number"
        ? nowSeconds() + payload.expires_in
        : (accessTokenExpiresAt(access) ?? nowSeconds() + 60 * 60)
    return {
      access: access.trim(),
      refresh: refresh.trim(),
      expires,
    }
  }

  // Standard RFC 8628 device authorization. PKCE (S256) is included to mirror
  // the openai-codex flow; auth.x.ai (Okta) supports code_challenge on the
  // device authorization request and code_verifier on the token request.
  export async function requestDeviceCode(fetchFn: FetchLike = fetch): Promise<{
    device: DeviceCode
    codeVerifier: string
  }> {
    const codeVerifier = randomToken(32)
    const response = await fetchFn(OAUTH_DEVICE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
        code_challenge: await sha256(codeVerifier),
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers)
      throw new RateLimitError({
        providerID: PROVIDER_ID,
        code: "rate_limited",
        message: retryAfterSeconds
          ? `xAI is rate-limiting Grok login requests. Try again in about ${retryAfterSeconds}s.`
          : "xAI is rate-limiting Grok login requests. Try again later.",
        retryAfterSeconds,
      })
    }
    if (!response.ok) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "device_code_request_failed",
        message: `Grok device-code request failed with status ${response.status}.`,
        reloginRequired: false,
      })
    }
    const payload = await safeJson(response)
    const deviceCode = payload.device_code
    const userCode = payload.user_code
    const verificationURI = payload.verification_uri ?? payload.verification_uri_complete
    if (
      typeof deviceCode !== "string" ||
      !deviceCode ||
      typeof userCode !== "string" ||
      !userCode ||
      typeof verificationURI !== "string" ||
      !verificationURI
    ) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "device_code_incomplete",
        message: "Grok device-code response was missing device_code, user_code, or verification_uri.",
        reloginRequired: false,
      })
    }
    const interval = Number(payload.interval)
    return {
      device: {
        deviceCode,
        userCode,
        verificationURI,
        intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.max(3, interval) : 5,
      },
      codeVerifier,
    }
  }

  export async function pollDeviceCode(
    input: { device: DeviceCode; codeVerifier: string },
    fetchFn: FetchLike = fetch,
    sleepFn: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ): Promise<TokenPayload> {
    const started = Date.now()
    const maxWaitMs = 15 * 60 * 1000
    let intervalSeconds = input.device.intervalSeconds
    while (Date.now() - started < maxWaitMs) {
      await sleepFn(intervalSeconds * 1000)
      const response = await fetchFn(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: input.device.deviceCode,
          client_id: OAUTH_CLIENT_ID,
          code_verifier: input.codeVerifier,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok) return toTokenPayload(await safeJson(response))
      const payload = await safeJson(response)
      const code = errorCode(payload)
      if (code === "authorization_pending") continue
      if (code === "slow_down") {
        intervalSeconds += 5
        continue
      }
      if (code === "access_denied" || code === "expired_token") {
        throw new AuthError({
          providerID: PROVIDER_ID,
          code: code ?? "device_code_denied",
          message:
            code === "access_denied"
              ? "Grok login was denied. Try again and approve the request."
              : "Grok device-code login expired. Start over.",
          reloginRequired: true,
        })
      }
      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfterSeconds(response.headers)
        throw new RateLimitError({
          providerID: PROVIDER_ID,
          code: "rate_limited",
          message: retryAfterSeconds
            ? `xAI is rate-limiting Grok login polling. Try again in about ${retryAfterSeconds}s.`
            : "xAI is rate-limiting Grok login polling. Try again later.",
          retryAfterSeconds,
        })
      }
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: code ?? "device_code_poll_failed",
        message: errorMessage(payload, `Grok device auth polling failed with status ${response.status}.`),
        reloginRequired: false,
      })
    }
    throw new AuthError({
      providerID: PROVIDER_ID,
      code: "device_code_timeout",
      message: "Grok login timed out after 15 minutes.",
      reloginRequired: false,
    })
  }

  export async function authorizeDeviceCode(fetchFn: FetchLike = fetch): Promise<AuthOuathResult> {
    const { device, codeVerifier } = await requestDeviceCode(fetchFn)
    return {
      url: device.verificationURI,
      method: "auto",
      instructions: device.userCode,
      async callback() {
        try {
          const token = await pollDeviceCode({ device, codeVerifier }, fetchFn)
          return {
            type: "success",
            access: token.access,
            refresh: token.refresh,
            expires: token.expires,
          }
        } catch (error) {
          log.error("grok device-code login failed", { error })
          return { type: "failed" }
        }
      },
    }
  }

  export async function refreshOAuth(
    auth: OAuthAuth,
    fetchFn: FetchLike = fetch,
    providerID = PROVIDER_ID,
  ): Promise<TokenPayload> {
    if (!auth.refresh) {
      throw new AuthError({
        providerID,
        code: "missing_refresh_token",
        message: "Grok credentials are missing a refresh token. Sign in again.",
        reloginRequired: true,
      })
    }
    const response = await fetchFn(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refresh,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers)
      throw new RateLimitError({
        providerID,
        code: "rate_limited",
        message: retryAfterSeconds
          ? `Grok provider quota exhausted or rate-limited. Retry after ${retryAfterSeconds}s. Credentials are still valid.`
          : "Grok provider quota exhausted or rate-limited. Credentials are still valid; retry after the usage limit resets.",
        retryAfterSeconds,
      })
    }
    if (!response.ok) {
      const payload = await safeJson(response)
      const code = errorCode(payload) ?? "grok_refresh_failed"
      const reloginRequired =
        ["invalid_grant", "invalid_token", "invalid_request", "refresh_token_reused"].includes(code) ||
        response.status === 401 ||
        response.status === 403
      throw new AuthError({
        providerID,
        code,
        message: errorMessage(payload, `Grok token refresh failed with status ${response.status}.`),
        reloginRequired,
      })
    }
    return toTokenPayload(await safeJson(response), auth.refresh)
  }

  export async function resolveToken(options?: {
    providerID?: string
    forceRefresh?: boolean
    refreshIfExpiring?: boolean
    allowMissing?: boolean
    fetch?: FetchLike
  }): Promise<string | undefined> {
    const providerID = options?.providerID ?? PROVIDER_ID
    const selected = await Auth.select(providerID)
    const auth = selected?.auth
    if (!selected || !auth || auth.type !== "oauth") {
      if (options?.allowMissing) return undefined
      throw new AuthError({
        providerID,
        code: "grok_auth_missing",
        message: "No Grok credentials stored. Run `synergy auth login` and choose Grok.",
        reloginRequired: true,
      })
    }

    const expires = accessTokenExpiresAt(auth.access) ?? auth.expires
    const shouldRefresh =
      options?.forceRefresh ||
      (options?.refreshIfExpiring !== false && expires <= nowSeconds() + AUTH_REFRESH_SKEW_SECONDS) ||
      (options?.refreshIfExpiring !== false && isAccessTokenExpiring(auth.access))

    if (!shouldRefresh) return auth.access

    let refreshCredentialID = selected.credentialID
    try {
      return await Auth.withLock(`${providerID}:oauth-refresh`, async () => {
        const latestSelected = await Auth.select(providerID)
        const latest = latestSelected?.auth
        refreshCredentialID = latestSelected?.credentialID ?? refreshCredentialID
        if (latest?.type === "oauth" && !options?.forceRefresh) {
          const latestExpires = accessTokenExpiresAt(latest.access) ?? latest.expires
          const latestShouldRefresh =
            (options?.refreshIfExpiring !== false && latestExpires <= nowSeconds() + AUTH_REFRESH_SKEW_SECONDS) ||
            (options?.refreshIfExpiring !== false && isAccessTokenExpiring(latest.access))
          if (!latestShouldRefresh) return latest.access
        }

        const refreshSource = latest?.type === "oauth" ? latest : auth
        const refreshed = await refreshOAuth(refreshSource, options?.fetch, providerID)
        await Auth.replaceSelectedCredential(
          providerID,
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
      if (RateLimitError.isInstance(error)) {
        await Auth.markExhausted(providerID, {
          failureCode: error.data.code,
          cooldownUntil: error.data.retryAfterSeconds ? nowSeconds() + error.data.retryAfterSeconds : undefined,
          credentialID: refreshCredentialID,
        }).catch(() => {})
        if (auth.access) return auth.access
      }
      if (AuthError.isInstance(error) && error.data.reloginRequired) {
        await Auth.markDead(providerID, error.data.code, { credentialID: refreshCredentialID }).catch(() => {})
      }
      if (options?.allowMissing && AuthError.isInstance(error) && error.data.reloginRequired) return undefined
      throw error
    }
  }

  export function grokFetchFor(providerID = PROVIDER_ID) {
    return async (input: RequestInfo | URL, init?: RequestInit) =>
      ProviderAuthRecovery.execute({
        providerID,
        request: async () => {
          const access = await resolveToken({ providerID, refreshIfExpiring: true })
          if (!access) {
            throw new AuthError({
              providerID,
              code: "grok_auth_missing",
              message: "No Grok credentials stored. Run `synergy auth login` and choose Grok.",
              reloginRequired: true,
            })
          }

          const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
          if (input instanceof Request && init?.headers) {
            for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
          }
          headers.set("Authorization", `Bearer ${access}`)
          headers.set("User-Agent", "synergy")
          headers.set("x-grok-client-surface", "synergy")

          return fetch(input, { ...init, headers })
        },
        refresh: async (auth) => refreshAuth(auth, fetch, providerID),
        classify: classifyError,
      })
  }

  export const grokFetch = grokFetchFor(PROVIDER_ID)

  export function classifyError(input: {
    status?: number
    body?: unknown
  }): ProviderProfile.ClassifiedError | undefined {
    const payload = input.body && typeof input.body === "object" ? (input.body as Record<string, any>) : {}
    const code = errorCode(payload) ?? (input.status === 401 ? "credential_rejected" : undefined)
    if (input.status === 429) {
      return { code: code ?? "rate_limited", retryable: true, exhausted: true }
    }
    const rejected =
      input.status === 401 ||
      ["invalid_token", "invalid_grant", "refresh_token_reused", "authentication_error"].includes(code ?? "")
    if (rejected) return { code: code ?? "credential_rejected", retryable: false, reloginRequired: true }
    // 403 may be an entitlement/allowlist rejection rather than a credential
    // problem; do not mark credentials dead for it.
    return undefined
  }

  export async function refreshAuth(
    auth: Auth.Info,
    fetchFn: FetchLike = fetch,
    providerID = PROVIDER_ID,
  ): Promise<Auth.Info | undefined> {
    if (auth.type !== "oauth") return undefined
    const refreshed = await refreshOAuth(auth, fetchFn, providerID)
    return {
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
    }
  }

  async function fetchModelPayload(
    accessToken: string,
    fetchFn: FetchLike = fetch,
    providerID = PROVIDER_ID,
    discoveryBaseURL = BASE_URL,
  ) {
    const response = await ProviderAuthRecovery.execute({
      providerID,
      request: async () => {
        const current =
          (await resolveToken({ providerID, allowMissing: true, fetch: fetchFn }).catch(() => undefined)) ?? accessToken
        return fetchFn(`${discoveryBaseURL.trim().replace(/\/+$/, "")}/language-models`, {
          headers: {
            Authorization: `Bearer ${current}`,
            Accept: "application/json",
            "User-Agent": "synergy",
            "x-grok-client-surface": "synergy",
          },
          signal: AbortSignal.timeout(10_000),
        })
      },
      refresh: (auth) => refreshAuth(auth, fetchFn, providerID),
      classify: classifyError,
      reloadOnTransition: false,
      throwOnActionRequired: false,
    })
    if (!response.ok) return []
    const payload = await safeJson(response)
    return Array.isArray(payload.models) ? payload.models : []
  }

  export async function fetchModelCatalog(
    accessToken: string,
    fetchFn: FetchLike = fetch,
    providerID = PROVIDER_ID,
    discoveryBaseURL = BASE_URL,
  ): Promise<ProviderProfile.ModelCatalogEntry[]> {
    const entries = await fetchModelPayload(accessToken, fetchFn, providerID, discoveryBaseURL)
    const models: ProviderProfile.ModelCatalogEntry[] = []
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue
      const id = entry.id
      if (typeof id !== "string" || !id.trim()) continue
      const inputModalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : []
      models.push({
        id: id.trim(),
        ...(inputModalities.includes("image") ? { inputImage: true } : {}),
      })
    }
    return models
  }
  export async function fetchUsage(
    fetchFn: FetchLike = fetch,
    providerID = PROVIDER_ID,
  ): Promise<AccountUsage.Snapshot> {
    void fetchFn
    return AccountUsage.unavailable(
      providerID,
      "Grok subscription usage is not exposed through an API; check grok.com Settings → Usage.",
    )
  }
}
