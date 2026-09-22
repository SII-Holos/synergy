import { afterEach, describe, expect, test } from "bun:test"
import { SecretResolve } from "../../src/secrets/resolve"
import { SecretVault } from "../../src/secrets/vault"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const tracked: string[] = []

afterEach(() =>
  runtime.run(async () => {
    for (const id of tracked.splice(0)) await SecretVault.remove(id).catch(() => {})
  }),
)

describe("SecretResolve execution boundary", () => {
  test("substitutes tokens in non-bash args through a cloned copy", () =>
    runtime.run(async () => {
      const value = `sk-deploy-${crypto.randomUUID()}`
      const entry = await SecretVault.register(value, { kind: "user" })
      tracked.push(entry.id)

      const original = { filePath: "/tmp/.env", content: `KEY=${SecretVault ? `⟦sec:${entry.id}⟧` : ""}` }
      const outcome = await SecretResolve.transformArgs(original, { sessionID: "ses_1", tool: "save_file" })

      expect(outcome.resolved).toBe(1)
      expect((outcome.args as Record<string, string>).content).toBe(`KEY=${value}`)
      // The original object the caller persists stays tokenized.
      expect(original.content).toBe(`KEY=⟦sec:${entry.id}⟧`)
    }))

  test("a standalone bash token becomes an env reference plus injected environment", () =>
    runtime.run(async () => {
      const value = `ghp_remote_${crypto.randomUUID()}`
      const entry = await SecretVault.register(value, { kind: "user" })
      tracked.push(entry.id)

      const outcome = await SecretResolve.transformArgs(
        { command: `echo ⟦sec:${entry.id}⟧` },
        { sessionID: "ses_1", tool: "bash" },
      )

      const name = `SYNERGY_SEC_${entry.id.toUpperCase()}`
      expect((outcome.args as Record<string, string>).command).toBe(`echo "\${${name}}"`)
      expect(outcome.secretEnv?.[name]).toBe(value)
      expect(JSON.stringify(outcome.args)).not.toContain(value)
    }))

  test("a bash token embedded in a longer word degrades to literal substitution", () =>
    runtime.run(async () => {
      const value = `tok_embed_${crypto.randomUUID()}`
      const entry = await SecretVault.register(value, { kind: "user" })
      tracked.push(entry.id)

      const outcome = await SecretResolve.transformArgs(
        { command: `curl -H "Auth: Bearer⟦sec:${entry.id}⟧" example.com` },
        { sessionID: "ses_1", tool: "bash" },
      )

      expect((outcome.args as Record<string, string>).command).toBe(`curl -H "Auth: Bearer${value}" example.com`)
      expect(outcome.secretEnv).toBeUndefined()
    }))

  test("policy denial renders the DENIED marker and the run proceeds", () =>
    runtime.run(async () => {
      const value = `sk-locked-${crypto.randomUUID()}`
      const entry = await SecretVault.register(value, { kind: "user" })
      tracked.push(entry.id)
      await SecretVault.updatePolicy(entry.id, { tools: ["save_file"] })

      const outcome = await SecretResolve.transformArgs(
        { command: `echo ⟦sec:${entry.id}⟧` },
        { sessionID: "ses_1", tool: "bash" },
      )
      expect((outcome.args as Record<string, string>).command).toContain(`⟦sec:${entry.id}:DENIED⟧`)
      expect(outcome.denied).toBe(1)
    }))

  test("a removed entry leaves the token literal, matching what the model saw", () =>
    runtime.run(async () => {
      const value = `ghp_ghost_${crypto.randomUUID()}`
      const entry = await SecretVault.register(value, { kind: "user" })
      await SecretVault.remove(entry.id)

      const outcome = await SecretResolve.transformArgs(
        { command: `echo ⟦sec:${entry.id}⟧` },
        { sessionID: "ses_1", tool: "bash" },
      )
      expect((outcome.args as Record<string, string>).command).toBe(`echo ⟦sec:${entry.id}⟧`)
      expect(outcome.resolved).toBe(0)
    }))

  test("args without tokens pass through without cloning", () =>
    runtime.run(async () => {
      const args = { filePath: "/tmp/plain", content: "nothing here" }
      const outcome = await SecretResolve.transformArgs(args, { sessionID: "ses_1", tool: "save_file" })
      expect(outcome.args).toBe(args)
      expect(outcome.resolved).toBe(0)
    }))

  test("substitution walks nested structures", () =>
    runtime.run(async () => {
      const value = `hf_nested_${crypto.randomUUID()}`
      const entry = await SecretVault.register(value, { kind: "user" })
      tracked.push(entry.id)

      const outcome = await SecretResolve.transformArgs(
        { config: { headers: { Authorization: `Bearer ⟦sec:${entry.id}⟧` } }, list: ["⟦sec:" + entry.id + "⟧"] },
        { sessionID: "ses_1", tool: "mcp__test" },
      )
      const args = outcome.args as { config: { headers: { Authorization: string } }; list: string[] }
      expect(args.config.headers.Authorization).toBe(`Bearer ${value}`)
      expect(args.list[0]).toBe(value)
      expect(outcome.resolved).toBe(2)
    }))
})

test("single-quoted Bash tokens receive the secret value", () =>
  runtime.run(async () => {
    const value = `key_quoted_fakekey_${crypto.randomUUID()}`
    const entry = await SecretVault.register(value, { kind: "user" })
    tracked.push(entry.id)
    const outcome = await SecretResolve.transformArgs({ command: `printf '%s' '⟦sec:${entry.id}⟧'` }, { tool: "bash" })
    const child = Bun.spawn(["bash", "-c", outcome.args.command], {
      env: { ...process.env, ...outcome.secretEnv },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await new Response(child.stdout).text()).toBe(value)
    expect(await child.exited).toBe(0)
  }))

test("standalone Bash tokens preserve spaces and shell metacharacters as one argument", () =>
  runtime.run(async () => {
    const value = `value with spaces * \" ' $(printf injected) ${crypto.randomUUID()}`
    const entry = await SecretVault.register(value, { kind: "user" })
    tracked.push(entry.id)
    const outcome = await SecretResolve.transformArgs({ command: `printf '<%s>' ⟦sec:${entry.id}⟧` }, { tool: "bash" })
    const child = Bun.spawn(["bash", "-c", outcome.args.command], {
      env: { ...process.env, ...outcome.secretEnv },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await new Response(child.stdout).text()).toBe(`<${value}>`)
    expect(await child.exited).toBe(0)
  }))

test("literal Bash substitution rejects values that could introduce shell syntax", () =>
  runtime.run(async () => {
    const entry = await SecretVault.register("$(printf injected)-fake-secret", { kind: "user" })
    tracked.push(entry.id)
    await expect(
      SecretResolve.transformArgs({ command: `printf '%s' prefix⟦sec:${entry.id}⟧` }, { tool: "bash" }),
    ).rejects.toThrow("standalone")
  }))

test("spaces around a token inside quotes do not authorize an unquoted expansion", () =>
  runtime.run(async () => {
    const entry = await SecretVault.register("credential with spaces", { kind: "user" })
    tracked.push(entry.id)
    await expect(
      SecretResolve.transformArgs({ command: `printf '%s' "prefix ⟦sec:${entry.id}⟧ suffix"` }, { tool: "bash" }),
    ).rejects.toThrow("standalone")
  }))

afterRuntimeTests(() => runtime.close())
