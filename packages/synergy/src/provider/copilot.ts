import { Auth } from "./api-key"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import type { AuthOuathResult } from "@ericsanchezok/synergy-plugin"
import z from "zod"

export namespace CopilotProvider {
  export const PROVIDER_ID = "github-copilot"
  export const ENTERPRISE_PROVIDER_ID = "github-copilot-enterprise"
  export const BASE_URL = "https://api.githubcopilot.com"
  export const OAUTH_CLIENT_ID = "Ov23li8tweQw6odWQebz"
  export const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token"
  export const EDITOR_VERSION = "vscode/1.104.1"
  export const USER_AGENT = "GitHubCopilotChat/0.26.7"
  export const API_TOKEN_REFRESH_MARGIN_SECONDS = 120

  type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export const AuthError = NamedError.create(
    "CopilotAuthError",
    z.object({
      providerID: z.string(),
      code: z.string(),
      message: z.string(),
      reloginRequired: z.boolean(),
    }),
  )

  function nowSeconds() {
    return Math.floor(Date.now() / 1000)
  }

  async function safeJson(response: Response): Promise<Record<string, any>> {
    try {
      const value = await response.json()
      return value && typeof value === "object" ? value : {}
    } catch {
      return {}
    }
  }

  function githubBase(providerID: string) {
    const enterprise = providerID === ENTERPRISE_PROVIDER_ID
    return enterprise ? process.env.COPILOT_GITHUB_ENTERPRISE_URL || "https://github.com" : "https://github.com"
  }

  export async function authorizeDeviceCode(
    providerID = PROVIDER_ID,
    fetchFn: FetchLike = fetch,
  ): Promise<AuthOuathResult> {
    const base = githubBase(providerID).replace(/\/+$/, "")
    const response = await fetchFn(`${base}/login/device/code`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Synergy/1.0",
      },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        scope: "read:user",
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new AuthError({
        providerID,
        code: "device_code_failed",
        message: `GitHub device-code request failed with status ${response.status}.`,
        reloginRequired: false,
      })
    }
    const payload = await safeJson(response)
    const deviceCode = payload.device_code
    const userCode = payload.user_code
    const verificationURI = payload.verification_uri ?? `${base}/login/device`
    const intervalSeconds = Math.max(1, Number(payload.interval ?? 5))
    const expiresIn = Math.max(60, Number(payload.expires_in ?? 300))
    return {
      url: verificationURI,
      method: "auto",
      instructions: String(userCode ?? ""),
      async callback() {
        const deadline = Date.now() + expiresIn * 1000
        let interval = intervalSeconds
        while (Date.now() < deadline) {
          await Bun.sleep(interval * 1000)
          const poll = await fetchFn(`${base}/login/oauth/access_token`, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "Synergy/1.0",
            },
            body: new URLSearchParams({
              client_id: OAUTH_CLIENT_ID,
              device_code: String(deviceCode),
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
            signal: AbortSignal.timeout(15_000),
          })
          const result = await safeJson(poll)
          if (typeof result.access_token === "string") {
            return {
              type: "success",
              provider: providerID,
              key: result.access_token,
            }
          }
          if (result.error === "authorization_pending") continue
          if (result.error === "slow_down") {
            interval += 5
            continue
          }
          return { type: "failed" }
        }
        return { type: "failed" }
      },
    }
  }

  function validateGitHubToken(token: string) {
    if (!token.trim()) return false
    if (token.startsWith("ghp_")) return false
    return true
  }

  export async function resolveGitHubToken(providerID = PROVIDER_ID): Promise<string | undefined> {
    for (const env of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
      const value = process.env[env]
      if (value && validateGitHubToken(value)) return value
    }
    const auth = await Auth.get(providerID)
    if (auth?.type === "api" && validateGitHubToken(auth.key)) return auth.key
    return undefined
  }

  export async function exchangeToken(providerID = PROVIDER_ID, fetchFn: FetchLike = fetch) {
    const auth = await Auth.get(providerID)
    const metadata = auth?.metadata ?? {}
    if (
      auth?.type === "api" &&
      typeof metadata.copilotApiToken === "string" &&
      typeof metadata.copilotApiTokenExpires === "number" &&
      metadata.copilotApiTokenExpires > nowSeconds() + API_TOKEN_REFRESH_MARGIN_SECONDS
    ) {
      return metadata.copilotApiToken
    }
    const githubToken = await resolveGitHubToken(providerID)
    if (!githubToken) {
      throw new AuthError({
        providerID,
        code: "github_token_missing",
        message: "No GitHub token available for GitHub Copilot.",
        reloginRequired: true,
      })
    }
    return Auth.withLock(`${providerID}:copilot-token`, async () => {
      const latest = await Auth.get(providerID)
      const latestMetadata = latest?.metadata ?? {}
      if (
        latest?.type === "api" &&
        typeof latestMetadata.copilotApiToken === "string" &&
        typeof latestMetadata.copilotApiTokenExpires === "number" &&
        latestMetadata.copilotApiTokenExpires > nowSeconds() + API_TOKEN_REFRESH_MARGIN_SECONDS
      ) {
        return latestMetadata.copilotApiToken
      }
      const response = await fetchFn(TOKEN_EXCHANGE_URL, {
        headers: {
          Authorization: `token ${githubToken}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          "Editor-Version": EDITOR_VERSION,
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        throw new AuthError({
          providerID,
          code: "copilot_token_exchange_failed",
          message: `Copilot token exchange failed with status ${response.status}.`,
          reloginRequired: response.status === 401 || response.status === 403,
        })
      }
      const payload = await safeJson(response)
      if (typeof payload.token !== "string") {
        throw new AuthError({
          providerID,
          code: "copilot_token_missing",
          message: "Copilot token exchange response was missing token.",
          reloginRequired: false,
        })
      }
      const expires = Number(payload.expires_at)
      const expiresAt = Number.isFinite(expires) && expires > 0 ? expires : nowSeconds() + 25 * 60
      await Auth.set(
        providerID,
        {
          type: "api",
          key: githubToken,
          metadata: {
            ...(latest?.metadata ?? auth?.metadata ?? {}),
            copilotApiToken: payload.token,
            copilotApiTokenExpires: expiresAt,
          },
        },
        { source: "api" },
      )
      return payload.token
    })
  }

  export function copilotFetchFor(providerID = PROVIDER_ID) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const token = await exchangeToken(providerID).catch(() => exchangeToken(PROVIDER_ID))
      const headers = new Headers(init?.headers)
      headers.set("Authorization", `Bearer ${token}`)
      headers.set("User-Agent", USER_AGENT)
      headers.set("Editor-Version", EDITOR_VERSION)
      headers.set("Copilot-Integration-Id", "vscode-chat")
      return fetch(input, { ...init, headers })
    }
  }

  export const copilotFetch = copilotFetchFor(PROVIDER_ID)

  export async function fetchModelIDs(providerID = PROVIDER_ID, fetchFn: FetchLike = fetch): Promise<string[]> {
    const token = await exchangeToken(providerID, fetchFn)
    const response = await fetchFn(`${BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Editor-Version": EDITOR_VERSION,
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return []
    const payload = await safeJson(response)
    const data = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
    return data.map((item) => item?.id).filter((id): id is string => typeof id === "string" && !!id)
  }
}
