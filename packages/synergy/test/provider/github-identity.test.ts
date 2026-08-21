import { afterEach, beforeEach, expect, test } from "bun:test"
import { Auth } from "../../src/provider/api-key"
import { GitHubProvider } from "../../src/provider/github"
import { GithubIdentity } from "../../src/provider/github-identity"
import { tmpdir } from "../fixture/fixture"

const originalGH = process.env.GH_TOKEN
const originalGITHUB = process.env.GITHUB_TOKEN
const originalGitGlobal = process.env.GIT_CONFIG_GLOBAL

async function readGlobal(key: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "config", "--global", key], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (code !== 0) return undefined
  return stdout.trim() || undefined
}

beforeEach(async () => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  await Auth.remove(GitHubProvider.PROVIDER_ID).catch(() => {})
})

afterEach(async () => {
  if (originalGH === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalGH
  if (originalGITHUB === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGITHUB
  if (originalGitGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = originalGitGlobal
  else delete process.env.GIT_CONFIG_GLOBAL
})

test("state reports git identity and pending changes without a GitHub account", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContextSafe(tmp, async () => {
    const state = await GithubIdentity.state()
    expect(state.enabled).toBe(false)
    expect(typeof state.gitName === "string" || state.gitName === undefined).toBe(true)
    expect(state.pendingChanges).toBeFalsy()
  })
})

async function ScopeContextSafe(tmp: Awaited<ReturnType<typeof tmpdir>>, fn: () => Promise<void>): Promise<void> {
  const { ScopeContext } = await import("../../src/scope/context")
  await ScopeContext.provide({ scope: await tmp.scope(), fn })
}

test("sync throws no_account when nothing is connected or configured", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContextSafe(tmp, async () => {
    const result = await GithubIdentity.sync().then(
      () => "resolved",
      (error) => error,
    )
    // Without an account AND without config overrides there is nothing to apply.
    expect(result).toBeInstanceOf(GithubIdentity.SyncError)
  })
})

test("explicit config overrides apply to git global config", async () => {
  // Point git's global config at a sandbox file so writes never touch the real user config.
  const sandboxGlobal = `${process.env.SYNERGY_TEST_ROOT}/github-identity-gitconfig-${Date.now()}`
  await Bun.write(sandboxGlobal, "")
  process.env.GIT_CONFIG_GLOBAL = sandboxGlobal

  await using tmp = await tmpdir({
    config: {
      github: {
        identitySync: { enabled: true, name: "Test User", email: "test@example.com" },
      },
    },
  })
  await ScopeContextSafe(tmp, async () => {
    const result = await GithubIdentity.sync()
    expect(result.applied).toBe(true)
    expect(result.changed).toContain("name")
    expect(result.changed).toContain("email")
    expect(await readGlobal("user.name")).toBe("Test User")
    expect(await readGlobal("user.email")).toBe("test@example.com")

    // Second sync is a no-op.
    const again = await GithubIdentity.sync()
    expect(again.applied).toBe(false)
    expect(again.reason).toBe("already in sync")

    // State reflects the synced values.
    const state = await GithubIdentity.state()
    expect(state.enabled).toBe(true)
    expect(state.gitName).toBe("Test User")
    expect(state.pendingChanges).toBeFalsy()
  })
})

test("account-derived identity is exposed through state when a token has account metadata", async () => {
  await using tmp = await tmpdir({ git: true })
  await Auth.set(GitHubProvider.PROVIDER_ID, {
    type: "api",
    key: "stored-token",
    metadata: { account: { login: "octocat", url: "https://github.com/octocat" } },
  } as never).catch(() => {})
  await ScopeContextSafe(tmp, async () => {
    const state = await GithubIdentity.state()
    expect(state.accountLogin).toBe("octocat")
    expect(state.accountEmail).toBe("octocat@users.noreply.github.com")
  })
})
