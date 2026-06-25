import { Auth } from "./api-key"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import type { AuthOuathResult } from "@ericsanchezok/synergy-plugin"
import z from "zod"

export namespace MiniMaxProvider {
  export const PROVIDER_ID = "minimax-oauth"
  export const CLIENT_ID = "78257093-7e40-4613-99e0-527b14b39113"
  export const SCOPE = "group_id profile model.completion"
  export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:user_code"
  export const GLOBAL_BASE = "https://api.minimax.io"
  export const GLOBAL_INFERENCE = "https://api.minimax.io/anthropic"
  export const AUTH_REFRESH_SKEW_SECONDS = 60

  type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export const AuthError = NamedError.create(
    "MiniMaxOAuthError",
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

  function randomToken(bytes = 32) {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")
  }

  async function sha256(input: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
    return Buffer.from(new Uint8Array(digest)).toString("base64url")
  }

  async function safeJson(response: Response): Promise<Record<string, any>> {
    try {
      const value = await response.json()
      return value && typeof value === "object" ? value : {}
    } catch {
      return {}
    }
  }

  function expiresFrom(raw: unknown) {
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) return nowSeconds() + 15 * 60
    if (value > Date.now() / 2) return Math.floor(value / 1000)
    return nowSeconds() + value
  }

  export async function authorizeOAuth(fetchFn: FetchLike = fetch): Promise<AuthOuathResult> {
    const verifier = randomToken(48).slice(0, 96)
    const challenge = await sha256(verifier)
    const state = randomToken(16)
    const response = await fetchFn(`${GLOBAL_BASE}/oauth/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "x-request-id": crypto.randomUUID(),
      },
      body: new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "authorization_failed",
        message: `MiniMax OAuth authorization failed with status ${response.status}.`,
        reloginRequired: false,
      })
    }
    const payload = await safeJson(response)
    if (
      payload.state !== state ||
      typeof payload.user_code !== "string" ||
      typeof payload.verification_uri !== "string"
    ) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "authorization_incomplete",
        message: "MiniMax OAuth response was missing user_code, verification_uri, or valid state.",
        reloginRequired: false,
      })
    }
    const userCode = payload.user_code
    const expiresAt = expiresFrom(payload.expired_in)
    const intervalMs = Number(payload.interval ?? 2000)
    return {
      url: payload.verification_uri,
      method: "auto",
      instructions: userCode,
      async callback() {
        while (nowSeconds() < expiresAt) {
          await Bun.sleep(Math.max(2000, Number.isFinite(intervalMs) ? intervalMs : 2000))
          const poll = await fetchFn(`${GLOBAL_BASE}/oauth/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
            body: new URLSearchParams({
              grant_type: GRANT_TYPE,
              client_id: CLIENT_ID,
              user_code: userCode,
              code_verifier: verifier,
            }),
            signal: AbortSignal.timeout(15_000),
          })
          if (!poll.ok) return { type: "failed" }
          const token = await safeJson(poll)
          if (token.status === "pending") continue
          if (token.status !== "success") return { type: "failed" }
          if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string")
            return { type: "failed" }
          return {
            type: "success",
            provider: PROVIDER_ID,
            access: token.access_token,
            refresh: token.refresh_token,
            expires: expiresFrom(token.expired_in),
          }
        }
        return { type: "failed" }
      },
    }
  }

  export async function refreshOAuth(auth: z.infer<typeof Auth.Oauth>, fetchFn: FetchLike = fetch) {
    const response = await fetchFn(`${GLOBAL_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: auth.refresh,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "refresh_failed",
        message: `MiniMax OAuth refresh failed with status ${response.status}.`,
        reloginRequired: response.status === 401 || response.status === 403,
      })
    }
    const payload = await safeJson(response)
    if (typeof payload.access_token !== "string") {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "missing_access_token",
        message: "MiniMax OAuth refresh response was missing access_token.",
        reloginRequired: true,
      })
    }
    return {
      access: payload.access_token,
      refresh: typeof payload.refresh_token === "string" ? payload.refresh_token : auth.refresh,
      expires: expiresFrom(payload.expired_in),
    }
  }

  export async function resolveToken(options?: { allowMissing?: boolean; fetch?: FetchLike }) {
    const auth = await Auth.get(PROVIDER_ID)
    if (!auth || auth.type !== "oauth") {
      if (options?.allowMissing) return undefined
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "minimax_oauth_missing",
        message: "No MiniMax OAuth credentials stored.",
        reloginRequired: true,
      })
    }
    if (auth.expires > nowSeconds() + AUTH_REFRESH_SKEW_SECONDS) return auth.access
    try {
      return await Auth.withLock(`${PROVIDER_ID}:oauth-refresh`, async () => {
        const latest = await Auth.get(PROVIDER_ID)
        if (latest?.type === "oauth" && latest.expires > nowSeconds() + AUTH_REFRESH_SKEW_SECONDS) return latest.access
        const refreshed = await refreshOAuth(latest?.type === "oauth" ? latest : auth, options?.fetch)
        await Auth.set(
          PROVIDER_ID,
          {
            type: "oauth",
            access: refreshed.access,
            refresh: refreshed.refresh,
            expires: refreshed.expires,
          },
          { source: "api" },
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

  export async function minimaxFetch(input: RequestInfo | URL, init?: RequestInit) {
    const token = await resolveToken()
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${token}`)
    return fetch(input, { ...init, headers })
  }
}
