import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { Global } from "../../src/global"
import { SecretVault } from "../../src/secrets/vault"

function randomValue(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

describe("SecretVault store discipline", () => {
  test("registers a value, persists a 0600 store, and derives a deterministic id", async () => {
    const value = randomValue("vault-deterministic")
    const entry = await SecretVault.register(value, { kind: "user" })

    expect(entry.id).toHaveLength(12)
    expect(entry.value).toBe(value)
    expect(entry.fingerprint.length).toBe(value.length)
    expect(entry.source).toEqual({ kind: "user" })
    expect(entry.resolvedCount).toBe(0)

    const again = await SecretVault.register(value, { kind: "heuristic", context: "tool_output" })
    expect(again.id).toBe(entry.id)

    const list = await SecretVault.list()
    const stored = list.find((item) => item.id === entry.id)
    expect(stored).toBeTruthy()
    expect((stored as Record<string, unknown>).value).toBeUndefined()

    const raw = await fs.readFile(Global.Path.secretVault, { encoding: "utf8" })
    const parsed = JSON.parse(raw)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.entries[entry.id].value).toBe(value)
    const mode = (await fs.stat(Global.Path.secretVault)).mode & 0o777
    expect(mode).toBe(0o600)

    await SecretVault.remove(entry.id)
  })

  test("the id is a pure function of the value across store recreation", async () => {
    // Two real values that share a SHA-256 Crockford prefix (brute-forced
    // pair) must still derive distinct fixed-length ids, and re-registering
    // must reproduce the same id so historical mask tokens restore.
    const first = await SecretVault.register("collision-probe-3241", { kind: "user" })
    const second = await SecretVault.register("collision-probe-18627", { kind: "user" })

    expect(first.id).toHaveLength(12)
    expect(second.id).toHaveLength(12)
    expect(first.id).not.toBe(second.id)

    await SecretVault.remove(first.id)
    const recreated = await SecretVault.register("collision-probe-3241", { kind: "user" })
    expect(recreated.id).toBe(first.id)

    await SecretVault.remove(first.id)
    await SecretVault.remove(second.id)
  })

  test("a corrupt store is quarantined and never wipes a later write", async () => {
    await fs.mkdir(Global.Path.auth, { recursive: true })
    await fs.writeFile(Global.Path.secretVault, "{not json", { mode: 0o600 })

    const value = randomValue("vault-corrupt")
    const entry = await SecretVault.register(value, { kind: "user" })
    expect(entry.value).toBe(value)

    const siblings = await fs.readdir(Global.Path.auth)
    expect(siblings.some((name) => name.startsWith("secret-vault.json.corrupt-"))).toBe(true)

    const raw = JSON.parse(await fs.readFile(Global.Path.secretVault, "utf8"))
    expect(raw.entries[entry.id].value).toBe(value)

    await SecretVault.remove(entry.id)
  })

  test("resolve records the audit trail and resolution accounting", async () => {
    const value = randomValue("vault-resolve")
    const entry = await SecretVault.register(value, { kind: "user" })

    const resolved = await SecretVault.resolve(entry.id, { sessionID: "ses_test", tool: "save_file" })
    expect(resolved).toEqual({ value })

    const after = await SecretVault.get(entry.id)
    expect(after?.resolvedCount).toBe(1)
    expect(after?.lastResolvedAt).toBeGreaterThan(0)

    const history = await SecretVault.resolveHistory(entry.id)
    expect(history.at(-1)).toMatchObject({ sessionID: "ses_test", tool: "save_file", outcome: "resolved" })

    await SecretVault.remove(entry.id)
  })

  test("policy denial keeps the run alive and records the refusal", async () => {
    const value = randomValue("vault-policy")
    const entry = await SecretVault.register(value, { kind: "user" })
    await SecretVault.updatePolicy(entry.id, { tools: ["mcp"] })

    const denied = await SecretVault.resolve(entry.id, { sessionID: "ses_test", tool: "bash" })
    expect(denied).toMatchObject({ denied: true })
    const history = await SecretVault.resolveHistory(entry.id)
    expect(history.at(-1)).toMatchObject({ outcome: "denied_policy", tool: "bash" })

    const allowed = await SecretVault.resolve(entry.id, { sessionID: "ses_test", tool: "mcp" })
    expect(allowed).toEqual({ value })

    await SecretVault.remove(entry.id)
  })

  test("rotate replaces the value, carries policy and history, and retires the old id", async () => {
    const value = randomValue("vault-rotate")
    const entry = await SecretVault.register(value, { kind: "user" })
    await SecretVault.updatePolicy(entry.id, { tools: ["bash"] })
    await SecretVault.resolve(entry.id, { sessionID: "ses_test", tool: "bash" })

    const nextValue = randomValue("vault-rotated")
    const rotated = await SecretVault.rotate(entry.id, nextValue)

    expect(rotated.id).toHaveLength(12)
    expect(rotated.policy).toEqual({ tools: ["bash"] })
    expect(await SecretVault.get(entry.id)).toBeUndefined()
    expect((await SecretVault.resolveHistory(rotated.id)).length).toBeGreaterThanOrEqual(1)
    expect(await SecretVault.resolve(entry.id, {})).toMatchObject({ denied: true })

    await SecretVault.remove(rotated.id)
  })

  test("syncFromConfig registers shaped config secrets once and is idempotent", async () => {
    const apiKey = randomValue("sk-test")
    const header = randomValue("bearer-test")
    const config = {
      provider: { testprov: { options: { apiKey } } },
      mcp: { testsrv: { options: { headers: { Authorization: header } } } },
      harmless: { nickname: "not-a-secret-value" },
    }

    const registered = await SecretVault.syncFromConfig(config)
    expect(registered.map((item) => item.value).sort()).toEqual([apiKey, header].sort())

    const again = await SecretVault.syncFromConfig(config)
    expect(again).toHaveLength(0)

    for (const id of registered) await SecretVault.remove(id.id)
  })
})
