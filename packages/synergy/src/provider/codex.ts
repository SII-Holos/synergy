import { Auth } from "@/provider/api-key"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import fs from "fs/promises"
import os from "os"
import path from "path"
import z from "zod"
import type { ModelsDev } from "./models"
import type { AuthOuathResult } from "@ericsanchezok/synergy-plugin"

export namespace CodexProvider {
  const log = Log.create({ service: "provider.codex" })

  export const PROVIDER_ID = "openai-codex"
  export const BASE_URL = "https://chatgpt.com/backend-api/codex"
  export const DEVICE_URL = "https://auth.openai.com/codex/device"
  export const OAUTH_ISSUER = "https://auth.openai.com"
  export const OAUTH_TOKEN_URL = `${OAUTH_ISSUER}/oauth/token`
  export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
  export const AUTH_REFRESH_SKEW_SECONDS = 5 * 60

  export const DEFAULT_MODEL_IDS = [
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
  ] as const

  type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export const AuthError = NamedError.create(
    "CodexAuthError",
    z.object({
      providerID: z.literal(PROVIDER_ID),
      code: z.string(),
      message: z.string(),
      reloginRequired: z.boolean(),
    }),
  )

  export const RateLimitError = NamedError.create(
    "CodexRateLimitError",
    z.object({
      providerID: z.literal(PROVIDER_ID),
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
    userCode: string
    deviceAuthID: string
    intervalSeconds: number
  }

  export function codexHome(input?: { codexHome?: string }) {
    return input?.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  }

  function baseURL() {
    return (process.env.SYNERGY_CODEX_BASE_URL || BASE_URL).trim().replace(/\/+$/, "")
  }

  export function runtimeBaseURL() {
    return baseURL()
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000)
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

  export function parseJWTClaims(token: string): Record<string, any> | undefined {
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

  export function accessTokenExpiresAt(token: string): number | undefined {
    const exp = parseJWTClaims(token)?.exp
    return typeof exp === "number" ? exp : undefined
  }

  export function isAccessTokenExpiring(token: string, skewSeconds = AUTH_REFRESH_SKEW_SECONDS) {
    const exp = accessTokenExpiresAt(token)
    if (!exp) return false
    return exp <= nowSeconds() + skewSeconds
  }

  export function chatGPTAccountID(token: string): string | undefined {
    const claims = parseJWTClaims(token)
    const nested = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id
    if (typeof nested === "string" && nested) return nested
    const flat = claims?.["https://api.openai.com/auth.chatgpt_account_id"]
    return typeof flat === "string" && flat ? flat : undefined
  }

  export function codexHeaders(accessToken: string) {
    const headers: Record<string, string> = {
      "User-Agent": "codex_cli_rs/0.0.0 (Synergy)",
      originator: "codex_cli_rs",
    }
    const accountID = chatGPTAccountID(accessToken)
    if (accountID) headers["ChatGPT-Account-ID"] = accountID
    return headers
  }

  function toTokenPayload(payload: Record<string, any>, fallbackRefresh?: string): TokenPayload {
    const access = payload.access_token
    if (typeof access !== "string" || !access.trim()) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "missing_access_token",
        message: "Codex token response was missing access_token.",
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
        message: "Codex token response was missing refresh_token.",
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

  export async function requestDeviceCode(fetchFn: FetchLike = fetch): Promise<DeviceCode> {
    const response = await fetchFn(`${OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers)
      throw new RateLimitError({
        providerID: PROVIDER_ID,
        code: "rate_limited",
        message: retryAfterSeconds
          ? `OpenAI is rate-limiting Codex login requests. Try again in about ${retryAfterSeconds}s.`
          : "OpenAI is rate-limiting Codex login requests. Try again later.",
        retryAfterSeconds,
      })
    }
    if (!response.ok) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "device_code_request_failed",
        message: `Codex device-code request failed with status ${response.status}.`,
        reloginRequired: false,
      })
    }
    const payload = await safeJson(response)
    const userCode = payload.user_code
    const deviceAuthID = payload.device_auth_id
    if (typeof userCode !== "string" || !userCode || typeof deviceAuthID !== "string" || !deviceAuthID) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "device_code_incomplete",
        message: "Codex device-code response was missing user_code or device_auth_id.",
        reloginRequired: false,
      })
    }
    const interval = Number(payload.interval)
    return {
      userCode,
      deviceAuthID,
      intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.max(3, interval) : 5,
    }
  }

  export async function exchangeAuthorizationCode(
    input: { authorizationCode: string; codeVerifier: string },
    fetchFn: FetchLike = fetch,
  ): Promise<TokenPayload> {
    const response = await fetchFn(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.authorizationCode,
        redirect_uri: `${OAUTH_ISSUER}/deviceauth/callback`,
        client_id: OAUTH_CLIENT_ID,
        code_verifier: input.codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers)
      throw new RateLimitError({
        providerID: PROVIDER_ID,
        code: "rate_limited",
        message: retryAfterSeconds
          ? `OpenAI is rate-limiting Codex token exchange. Try again in about ${retryAfterSeconds}s.`
          : "OpenAI is rate-limiting Codex token exchange. Try again later.",
        retryAfterSeconds,
      })
    }
    if (!response.ok) {
      const payload = await safeJson(response)
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: errorCode(payload) ?? "token_exchange_failed",
        message: errorMessage(payload, `Codex token exchange failed with status ${response.status}.`),
        reloginRequired: response.status === 401 || response.status === 403,
      })
    }
    return toTokenPayload(await safeJson(response))
  }

  export async function pollDeviceCode(input: DeviceCode, fetchFn: FetchLike = fetch): Promise<TokenPayload> {
    const started = Date.now()
    const maxWaitMs = 15 * 60 * 1000
    while (Date.now() - started < maxWaitMs) {
      await Bun.sleep(input.intervalSeconds * 1000)
      const response = await fetchFn(`${OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          device_auth_id: input.deviceAuthID,
          user_code: input.userCode,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok) {
        const payload = await safeJson(response)
        const authorizationCode = payload.authorization_code
        const codeVerifier = payload.code_verifier
        if (
          typeof authorizationCode !== "string" ||
          !authorizationCode ||
          typeof codeVerifier !== "string" ||
          !codeVerifier
        ) {
          throw new AuthError({
            providerID: PROVIDER_ID,
            code: "device_code_incomplete_exchange",
            message: "Codex device auth response was missing authorization_code or code_verifier.",
            reloginRequired: false,
          })
        }
        return exchangeAuthorizationCode({ authorizationCode, codeVerifier }, fetchFn)
      }
      if (response.status === 403 || response.status === 404) continue
      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfterSeconds(response.headers)
        throw new RateLimitError({
          providerID: PROVIDER_ID,
          code: "rate_limited",
          message: retryAfterSeconds
            ? `OpenAI is rate-limiting Codex login polling. Try again in about ${retryAfterSeconds}s.`
            : "OpenAI is rate-limiting Codex login polling. Try again later.",
          retryAfterSeconds,
        })
      }
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "device_code_poll_failed",
        message: `Codex device auth polling failed with status ${response.status}.`,
        reloginRequired: false,
      })
    }
    throw new AuthError({
      providerID: PROVIDER_ID,
      code: "device_code_timeout",
      message: "Codex login timed out after 15 minutes.",
      reloginRequired: false,
    })
  }

  export async function authorizeDeviceCode(fetchFn: FetchLike = fetch): Promise<AuthOuathResult> {
    const device = await requestDeviceCode(fetchFn)
    return {
      url: DEVICE_URL,
      method: "auto",
      instructions: device.userCode,
      async callback() {
        try {
          const token = await pollDeviceCode(device, fetchFn)
          return {
            type: "success",
            access: token.access,
            refresh: token.refresh,
            expires: token.expires,
          }
        } catch (error) {
          log.error("codex device-code login failed", { error })
          return { type: "failed" }
        }
      },
    }
  }

  export async function refreshOAuth(auth: OAuthAuth, fetchFn: FetchLike = fetch): Promise<TokenPayload> {
    if (!auth.refresh) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "missing_refresh_token",
        message: "Codex credentials are missing a refresh token. Sign in again with ChatGPT.",
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
        providerID: PROVIDER_ID,
        code: "rate_limited",
        message: retryAfterSeconds
          ? `Codex provider quota exhausted or rate-limited. Retry after ${retryAfterSeconds}s. Credentials are still valid.`
          : "Codex provider quota exhausted or rate-limited. Credentials are still valid; retry after the usage limit resets.",
        retryAfterSeconds,
      })
    }
    if (!response.ok) {
      const payload = await safeJson(response)
      const code = errorCode(payload) ?? "codex_refresh_failed"
      const reloginRequired =
        ["invalid_grant", "invalid_token", "invalid_request", "refresh_token_reused"].includes(code) ||
        response.status === 401 ||
        response.status === 403
      throw new AuthError({
        providerID: PROVIDER_ID,
        code,
        message: errorMessage(payload, `Codex token refresh failed with status ${response.status}.`),
        reloginRequired,
      })
    }
    return toTokenPayload(await safeJson(response), auth.refresh)
  }

  export async function resolveToken(options?: {
    forceRefresh?: boolean
    refreshIfExpiring?: boolean
    allowMissing?: boolean
    fetch?: FetchLike
  }): Promise<string | undefined> {
    const auth = await Auth.get(PROVIDER_ID)
    if (!auth || auth.type !== "oauth") {
      if (options?.allowMissing) return undefined
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "codex_auth_missing",
        message: "No Codex credentials stored. Run `synergy auth login` and choose OpenAI Codex.",
        reloginRequired: true,
      })
    }

    const expires = accessTokenExpiresAt(auth.access) ?? auth.expires
    const shouldRefresh =
      options?.forceRefresh ||
      (options?.refreshIfExpiring !== false && expires <= nowSeconds() + AUTH_REFRESH_SKEW_SECONDS) ||
      (options?.refreshIfExpiring !== false && isAccessTokenExpiring(auth.access))

    if (!shouldRefresh) return auth.access

    try {
      const refreshed = await refreshOAuth(auth, options?.fetch)
      await Auth.set(PROVIDER_ID, {
        type: "oauth",
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      })
      return refreshed.access
    } catch (error) {
      if (RateLimitError.isInstance(error) && auth.access) return auth.access
      if (options?.allowMissing && AuthError.isInstance(error) && error.data.reloginRequired) return undefined
      throw error
    }
  }

  export async function importCodexCliAuth(input?: { codexHome?: string }): Promise<TokenPayload | undefined> {
    const authPath = path.join(codexHome(input), "auth.json")
    let payload: any
    try {
      payload = JSON.parse(await fs.readFile(authPath, "utf8"))
    } catch {
      return undefined
    }
    const tokens = payload?.tokens
    if (!tokens || typeof tokens !== "object") return undefined
    if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") return undefined
    if (isAccessTokenExpiring(tokens.access_token, 0)) return undefined
    return {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: accessTokenExpiresAt(tokens.access_token) ?? nowSeconds() + 60 * 60,
    }
  }

  function displayName(modelID: string) {
    return modelID
      .split("-")
      .map((part) =>
        part === "gpt" ? "GPT" : part === "codex" ? "Codex" : part.charAt(0).toUpperCase() + part.slice(1),
      )
      .join(" ")
  }

  function fallbackModel(modelID: string): ModelsDev.Model {
    const isSpark = modelID.includes("spark")
    const isLarge = modelID === "gpt-5.5" || modelID === "gpt-5.4"
    return {
      id: modelID,
      name: displayName(modelID),
      family: modelID.includes("codex") ? "gpt-codex" : "gpt",
      release_date: "2026-06-25",
      attachment: true,
      reasoning: true,
      temperature: false,
      tool_call: true,
      cost: { input: 0, output: 0 },
      limit: isSpark
        ? { context: 128000, input: 100000, output: 32000 }
        : isLarge
          ? { context: 1050000, input: 922000, output: 128000 }
          : { context: 400000, input: 272000, output: 128000 },
      modalities: {
        input: ["text", "image", "pdf"],
        output: ["text"],
      },
      options: {},
      provider: {
        npm: "@ai-sdk/openai",
      },
    }
  }

  export function modelsDevProvider(
    modelIDs: Iterable<string> = DEFAULT_MODEL_IDS,
    openaiModels?: Record<string, ModelsDev.Model>,
  ): ModelsDev.Provider {
    const models: Record<string, ModelsDev.Model> = {}
    for (const modelID of Array.from(new Set(modelIDs))) {
      const source = openaiModels?.[modelID]
      models[modelID] = source
        ? {
            ...source,
            id: modelID,
            options: { ...source.options },
            headers: { ...source.headers },
            provider: { npm: "@ai-sdk/openai" },
          }
        : fallbackModel(modelID)
    }
    return {
      id: PROVIDER_ID,
      name: "OpenAI Codex",
      env: [],
      npm: "@ai-sdk/openai",
      api: baseURL(),
      models,
    }
  }

  export async function fetchModelIDs(accessToken: string, fetchFn: FetchLike = fetch): Promise<string[]> {
    const response = await fetchFn(`${baseURL()}/models?client_version=1.0.0`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...codexHeaders(accessToken),
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return []
    const payload = await safeJson(response)
    const entries = Array.isArray(payload.models) ? payload.models : []
    const models: Array<{ slug: string; rank: number }> = []
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue
      if (typeof entry.slug !== "string" || !entry.slug.trim()) continue
      if (typeof entry.visibility === "string" && ["hide", "hidden"].includes(entry.visibility.toLowerCase())) continue
      models.push({
        slug: entry.slug.trim(),
        rank: typeof entry.priority === "number" ? entry.priority : 10_000,
      })
    }
    return models.sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug)).map((item) => item.slug)
  }

  export async function runtimeModelIDs(fetchFn: FetchLike = fetch): Promise<string[]> {
    const access = await resolveToken({ allowMissing: true, fetch: fetchFn }).catch((error) => {
      log.warn("failed to resolve codex token for model discovery", { error })
      return undefined
    })
    if (!access) return [...DEFAULT_MODEL_IDS]
    const live = await fetchModelIDs(access, fetchFn).catch((error) => {
      log.warn("failed to fetch codex model list", { error })
      return []
    })
    return live.length > 0 ? live : [...DEFAULT_MODEL_IDS]
  }

  function extractPromptCacheKey(body: unknown): string | undefined {
    if (!body || typeof body !== "object") return undefined
    const value = (body as Record<string, unknown>).prompt_cache_key
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }

  function rewriteCodexBody(body: BodyInit | null | undefined) {
    if (typeof body !== "string") return { body, promptCacheKey: undefined }
    try {
      const parsed = JSON.parse(body)
      const promptCacheKey = extractPromptCacheKey(parsed)
      if (parsed && typeof parsed === "object" && "max_output_tokens" in parsed) {
        delete parsed.max_output_tokens
        return { body: JSON.stringify(parsed), promptCacheKey }
      }
      return { body, promptCacheKey }
    } catch {
      return { body, promptCacheKey: undefined }
    }
  }

  export async function codexFetch(input: RequestInfo | URL, init?: RequestInit) {
    const access = await resolveToken({ refreshIfExpiring: true })
    if (!access) {
      throw new AuthError({
        providerID: PROVIDER_ID,
        code: "codex_auth_missing",
        message: "No Codex credentials stored. Run `synergy auth login` and choose OpenAI Codex.",
        reloginRequired: true,
      })
    }

    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${access}`)
    for (const [key, value] of Object.entries(codexHeaders(access))) {
      headers.set(key, value)
    }

    const rewritten = rewriteCodexBody(init?.body)
    if (rewritten.promptCacheKey) {
      headers.set("session_id", rewritten.promptCacheKey)
      headers.set("x-client-request-id", rewritten.promptCacheKey)
    }

    return fetch(input, {
      ...init,
      headers,
      body: rewritten.body,
    })
  }

  export async function saveImportedToken(token: TokenPayload) {
    await Auth.set(PROVIDER_ID, {
      type: "oauth",
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
    })
  }

  export function authFilePath() {
    return Global.Path.authApiKey
  }
}
