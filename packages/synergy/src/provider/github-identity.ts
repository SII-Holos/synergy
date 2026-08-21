import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Config } from "../config/config"
import { GitHubProvider } from "./github"
import { Log } from "../util/log"

/**
 * Git identity sync for the GitHub integration.
 *
 * Keeps the machine-level `git config --global user.name / user.email` in
 * sync with the connected GitHub account. Explicit `name`/`email` config
 * overrides win over the account-derived defaults. Runs are explicit
 * (settings panel "Sync now", or the server on GitHub credential changes
 * when sync was previously enabled) — never as a noisy background loop.
 */
export namespace GithubIdentity {
  const log = Log.create({ service: "github.identity" })

  export const State = z
    .object({
      enabled: z.boolean(),
      configuredName: z.string().optional(),
      configuredEmail: z.string().optional(),
      gitName: z.string().optional(),
      gitEmail: z.string().optional(),
      accountLogin: z.string().optional(),
      accountName: z.string().optional(),
      accountEmail: z.string().optional(),
      accountUrl: z.string().optional(),
      pendingChanges: z.boolean().optional(),
    })
    .meta({ ref: "GithubIdentityState" })
  export type State = z.infer<typeof State>

  export const SyncResult = z
    .object({
      applied: z.boolean(),
      name: z.string().optional(),
      email: z.string().optional(),
      changed: z.array(z.string()),
      reason: z.string().optional(),
    })
    .meta({ ref: "GithubIdentitySyncResult" })
  export type SyncResult = z.infer<typeof SyncResult>

  export const SyncError = NamedError.create(
    "GithubIdentitySyncError",
    z.object({
      code: z.enum(["no_account", "git_failed"]),
      message: z.string(),
    }),
  )

  function git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    return Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
      ([code, stdout, stderr]) => ({ code, stdout, stderr }),
    )
  }

  async function readGitGlobal(key: string): Promise<string | undefined> {
    const result = await git(["config", "--global", key])
    if (result.code !== 0) return undefined
    const value = result.stdout.trim()
    return value || undefined
  }

  async function writeGitGlobal(key: string, value: string): Promise<void> {
    const result = await git(["config", "--global", key, value])
    if (result.code !== 0) {
      throw new SyncError({
        code: "git_failed",
        message: `git config --global ${key} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      })
    }
  }

  /**
   * Identity the sync would apply right now: overrides first, account-derived
   * fallback. Credentials without stored account metadata (e.g. env tokens)
   * trigger a one-off account lookup so the derived identity is still
   * available; lookup failures fall back to override-only.
   */
  export async function targetIdentity(): Promise<{ name?: string; email?: string; account?: GitHubProvider.Account }> {
    const cfg = (await Config.current().catch(() => undefined))?.github?.identitySync
    const resolved = await GitHubProvider.resolveToken()
    let account = resolved?.account
    if (!account && resolved?.token) {
      account = await GitHubProvider.fetchAccount(resolved.token).catch(() => undefined)
    }
    // Stored null clears an override (settings sends null on blank).
    const name = (cfg?.name ?? undefined)?.trim() || account?.login
    const email =
      (cfg?.email ?? undefined)?.trim() || (account ? `${account.login}@users.noreply.github.com` : undefined)
    return { name, email, account }
  }

  export async function state(): Promise<State> {
    const cfg = (await Config.current().catch(() => undefined))?.github?.identitySync
    const [gitName, gitEmail, target] = await Promise.all([
      readGitGlobal("user.name"),
      readGitGlobal("user.email"),
      targetIdentity(),
    ])
    const pendingChanges = Boolean(
      cfg?.enabled && ((target.name && target.name !== gitName) || (target.email && target.email !== gitEmail)),
    )
    return {
      enabled: cfg?.enabled === true,
      configuredName: cfg?.name ?? undefined,
      configuredEmail: cfg?.email ?? undefined,
      gitName,
      gitEmail,
      accountLogin: target.account?.login,
      accountName: target.account?.login,
      accountEmail: target.account ? `${target.account.login}@users.noreply.github.com` : undefined,
      accountUrl: target.account?.url,
      pendingChanges,
    }
  }

  export async function sync(): Promise<SyncResult> {
    const cfg = (await Config.current().catch(() => undefined))?.github?.identitySync
    const target = await targetIdentity()
    if (!target.name && !target.email) {
      throw new SyncError({
        code: "no_account",
        message: "No GitHub account is connected and no explicit name/email override is configured.",
      })
    }
    const changed: string[] = []
    if (target.name) {
      const current = await readGitGlobal("user.name")
      if (current !== target.name) {
        await writeGitGlobal("user.name", target.name)
        changed.push("name")
      }
    }
    if (target.email) {
      const current = await readGitGlobal("user.email")
      if (current !== target.email) {
        await writeGitGlobal("user.email", target.email)
        changed.push("email")
      }
    }
    log.info("identity sync complete", { changed, explicit: cfg?.enabled === true })
    return {
      applied: changed.length > 0,
      name: target.name,
      email: target.email,
      changed,
      reason: changed.length === 0 ? "already in sync" : undefined,
    }
  }
}
