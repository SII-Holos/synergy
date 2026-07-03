import { Auth } from "./api-key"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import type { AuthOuathResult } from "@ericsanchezok/synergy-plugin"
import z from "zod"

export namespace GitHubProvider {
  export const PROVIDER_ID = "github"
  export const OAUTH_CLIENT_ID_ENV = "SYNERGY_GITHUB_OAUTH_CLIENT_ID"
  export const DEVICE_SCOPE = "repo read:user"
  export const USER_AGENT = "Synergy/1.0"

  type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export const Account = z
    .object({
      login: z.string(),
      id: z.number().optional(),
      url: z.string().optional(),
    })
    .meta({ ref: "GitHubAccount" })
  export type Account = z.infer<typeof Account>

  export const Status = z
    .object({
      providerID: z.literal(PROVIDER_ID),
      status: z.enum(["connected", "not_configured", "invalid", "unverified"]),
      source: z.enum(["env", "store"]).optional(),
      authKind: z.enum(["api_key", "oauth"]).optional(),
      account: Account.optional(),
      failureCode: z.string().optional(),
      updatedAt: z.number().optional(),
    })
    .meta({ ref: "GitHubAuthStatus" })
  export type Status = z.infer<typeof Status>

  export const AuthError = NamedError.create(
    "GitHubAuthError",
    z.object({
      code: z.string(),
      message: z.string(),
      reloginRequired: z.boolean(),
    }),
  )

  async function safeJson(response: Response): Promise<Record<string, any>> {
    try {
      const value = await response.json()
      return value && typeof value === "object" ? value : {}
    } catch {
      return {}
    }
  }

  export function oauthClientID() {
    return process.env[OAUTH_CLIENT_ID_ENV]?.trim()
  }

  export function hasOAuthClient() {
    return Boolean(oauthClientID())
  }

  function accountFromPayload(payload: Record<string, any>): Account | undefined {
    if (typeof payload.login !== "string" || !payload.login) return undefined
    return {
      login: payload.login,
      ...(typeof payload.id === "number" ? { id: payload.id } : {}),
      ...(typeof payload.html_url === "string" ? { url: payload.html_url } : {}),
    }
  }

  function accountFromMetadata(metadata: Record<string, any> | undefined): Account | undefined {
    return Account.safeParse(metadata?.account).success ? Account.parse(metadata?.account) : undefined
  }

  export async function fetchAccount(token: string, fetchFn: FetchLike = fetch): Promise<Account | undefined> {
    const response = await fetchFn("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new AuthError({
        code: response.status === 401 || response.status === 403 ? "github_token_invalid" : "github_user_failed",
        message: `GitHub account lookup failed with status ${response.status}.`,
        reloginRequired: response.status === 401 || response.status === 403,
      })
    }
    return accountFromPayload(await safeJson(response))
  }

  export async function authorizeDeviceCode(fetchFn: FetchLike = fetch): Promise<AuthOuathResult> {
    const clientID = oauthClientID()
    if (!clientID) {
      throw new AuthError({
        code: "github_oauth_client_missing",
        message: `${OAUTH_CLIENT_ID_ENV} must be configured before GitHub device login can be used.`,
        reloginRequired: false,
      })
    }
    const response = await fetchFn("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: clientID,
        scope: DEVICE_SCOPE,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new AuthError({
        code: "device_code_failed",
        message: `GitHub device-code request failed with status ${response.status}.`,
        reloginRequired: false,
      })
    }
    const payload = await safeJson(response)
    const deviceCode = payload.device_code
    const userCode = payload.user_code
    const verificationURI = payload.verification_uri ?? "https://github.com/login/device"
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
          const poll = await fetchFn("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": USER_AGENT,
            },
            body: new URLSearchParams({
              client_id: clientID,
              device_code: String(deviceCode),
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
            signal: AbortSignal.timeout(15_000),
          })
          const result = await safeJson(poll)
          if (typeof result.access_token === "string") {
            await fetchAccount(result.access_token, fetchFn).catch(() => undefined)
            return {
              type: "success",
              provider: PROVIDER_ID,
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

  export async function importCliToken(): Promise<
    { type: "success"; provider?: string; key: string } | { type: "failed"; message?: string }
  > {
    const proc = Bun.spawn({
      cmd: ["gh", "auth", "token"],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (exitCode !== 0) {
      return {
        type: "failed",
        message: stderr.trim() || "No GitHub CLI token was available in the Synergy server environment.",
      }
    }
    const token = stdout.trim()
    if (!token) return { type: "failed", message: "GitHub CLI returned an empty token." }
    await fetchAccount(token).catch(() => undefined)
    return {
      type: "success",
      provider: PROVIDER_ID,
      key: token,
    }
  }

  export async function resolveToken(): Promise<
    | {
        token: string
        source: "env" | "store"
        authKind: "api_key" | "oauth"
        account?: Account
        updatedAt?: number
      }
    | undefined
  > {
    for (const env of ["GH_TOKEN", "GITHUB_TOKEN"]) {
      const value = process.env[env]
      if (value?.trim()) {
        return {
          token: value,
          source: "env",
          authKind: "api_key",
        }
      }
    }

    const selected = await Auth.select(PROVIDER_ID)
    const auth = selected?.auth
    if (!selected) return undefined
    if (auth?.type === "api" && auth.key.trim()) {
      return {
        token: auth.key,
        source: "store",
        authKind: "api_key",
        account: accountFromMetadata(auth.metadata),
        updatedAt: selected.poolEntry?.updatedAt ?? selected.entry.updatedAt,
      }
    }
    if (auth?.type === "oauth" && auth.access.trim()) {
      return {
        token: auth.access,
        source: "store",
        authKind: "oauth",
        account: accountFromMetadata(auth.metadata),
        updatedAt: selected.poolEntry?.updatedAt ?? selected.entry.updatedAt,
      }
    }
    return undefined
  }

  export async function status(fetchFn: FetchLike = fetch): Promise<Status> {
    const resolved = await resolveToken()
    if (!resolved) return { providerID: PROVIDER_ID, status: "not_configured" }
    if (resolved.account) {
      return {
        providerID: PROVIDER_ID,
        status: "connected",
        source: resolved.source,
        authKind: resolved.authKind,
        account: resolved.account,
        updatedAt: resolved.updatedAt,
      }
    }
    const account = await fetchAccount(resolved.token, fetchFn).catch((error) => {
      if (AuthError.isInstance(error) && error.data.reloginRequired) return "invalid" as const
      return undefined
    })
    if (account === "invalid") {
      return {
        providerID: PROVIDER_ID,
        status: "invalid",
        source: resolved.source,
        authKind: resolved.authKind,
        updatedAt: resolved.updatedAt,
        failureCode: "github_token_invalid",
      }
    }
    if (!account) {
      return {
        providerID: PROVIDER_ID,
        status: "unverified",
        source: resolved.source,
        authKind: resolved.authKind,
        updatedAt: resolved.updatedAt,
        failureCode: "github_account_lookup_failed",
      }
    }
    return {
      providerID: PROVIDER_ID,
      status: "connected",
      source: resolved.source,
      authKind: resolved.authKind,
      account,
      updatedAt: resolved.updatedAt,
    }
  }

  export async function remove() {
    await Auth.remove(PROVIDER_ID)
  }
}
