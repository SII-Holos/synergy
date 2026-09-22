import { afterEach, beforeEach, expect, test } from "bun:test"
import { Auth } from "@ericsanchezok/synergy-harness/provider/api-key"
import { GitHubProvider } from "@ericsanchezok/synergy-harness/provider/github"
import { GithubIdentity } from "../../src/github/identity"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
const fixture = await runtimeHome()
const sandboxGlobal = `${fixture.host.home}/.gitconfig`
const runtime = await testRuntime({
  env: { GIT_CONFIG_GLOBAL: sandboxGlobal, GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
})

async function readGlobal(key: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "config", "--global", key], {
    stdout: "pipe",
    stderr: "pipe",
    env: runtime.host.env,
  })
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (code !== 0) return undefined
  return stdout.trim() || undefined
}

beforeEach(() =>
  runtime.run(async () => {
    await Auth.remove(GitHubProvider.PROVIDER_ID).catch(() => {})
  }),
)

test("state reports git identity and pending changes without a GitHub account", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContextSafe(tmp, async () => {
      const state = await GithubIdentity.state()
      expect(state.enabled).toBe(false)
      expect(typeof state.gitName === "string" || state.gitName === undefined).toBe(true)
      expect(state.pendingChanges).toBeFalsy()
    })
  }))

async function ScopeContextSafe(tmp: Awaited<ReturnType<typeof tmpdir>>, fn: () => Promise<void>): Promise<void> {
  const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
  await ScopeContext.provide({ scope: await tmp.scope(), fn })
}

test("sync throws no_account when nothing is connected or configured", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContextSafe(tmp, async () => {
      const result = await GithubIdentity.sync().then(
        () => "resolved",
        (error) => error,
      )
      // Without an account AND without config overrides there is nothing to apply.
      expect(result).toBeInstanceOf(GithubIdentity.SyncError)
    })
  }))

test("explicit config overrides apply to git global config", () =>
  runtime.run(async () => {
    // Point git's global config at a sandbox file so writes never touch the real user config.
    await Bun.write(sandboxGlobal, "")

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
  }))

test("account-derived identity is exposed through state when a token has account metadata", () =>
  runtime.run(async () => {
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
  }))

afterRuntimeTests(async () => {
  await runtime.close()
  await fixture[Symbol.asyncDispose]()
})
