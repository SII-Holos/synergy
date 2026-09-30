import { afterAll, expect, test } from "bun:test"
import { BrowserProfiles } from "../src/profiles"
import { testRuntime } from "./support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("personal identity is durable and shared without using a task or port as identity", () =>
  runtime.run(async () => {
    const first = await BrowserProfiles.defaultProfile()
    const second = await BrowserProfiles.defaultProfile()
    expect(second.id).toBe(first.id)
    expect(second.partition).toBe(first.partition)
    expect(first.kind).toBe("persistent")
    expect(first.partition.startsWith("persist:synergy-browser-")).toBe(true)
    expect((await BrowserProfiles.list()).profiles.map((profile) => profile.id)).toContain(first.id)
  }))

test("named profiles, revocation and the default survive catalog reads", () =>
  runtime.run(async () => {
    const personal = await BrowserProfiles.defaultProfile()
    const work = await BrowserProfiles.create({ name: "Work" })
    expect(work.partition).not.toBe(personal.partition)
    await BrowserProfiles.update(work.id, { name: "Work account" })
    await BrowserProfiles.setDefault(work.id)
    expect((await BrowserProfiles.defaultProfile()).id).toBe(work.id)
    await BrowserProfiles.setPolicy(work.id, "https://example.com", { access: "deny" })
    expect((await BrowserProfiles.get(work.id)).origins["https://example.com"]?.access).toBe("deny")
    await BrowserProfiles.setPolicy(work.id, "https://example.com", null)
    expect((await BrowserProfiles.get(work.id)).origins["https://example.com"]).toBeUndefined()
    await BrowserProfiles.update(work.id, { enabled: false })
    await expect(BrowserProfiles.requireEnabled(work.id)).rejects.toThrow("disabled")
    expect((await BrowserProfiles.defaultProfile()).id).toBe(personal.id)
  }))

test("temporary identities never enter the persisted profile catalog", () =>
  runtime.run(async () => {
    const temporary = await BrowserProfiles.create({ name: "Temporary", kind: "temporary" })
    expect(temporary.partition.startsWith("persist:")).toBe(false)
    expect((await BrowserProfiles.list()).profiles.some((profile) => profile.id === temporary.id)).toBe(false)
    BrowserProfiles.releaseTemporary(temporary.id)
    await expect(BrowserProfiles.get(temporary.id)).rejects.toThrow("not found")
  }))

test("legacy identities reuse the exact native partition without merging accounts", () =>
  runtime.run(async () => {
    const a = await BrowserProfiles.legacy("scope:a:session:one")
    const b = await BrowserProfiles.legacy("scope:a:session:two")
    expect(a.partition).not.toBe(b.partition)
    expect((await BrowserProfiles.legacy("scope:a:session:one")).id).toBe(a.id)
    expect(a.partition).toBe(
      `persist:synergy-browser-${new Bun.CryptoHasher("sha256").update("scope:a:session:one").digest("hex")}`,
    )
  }))
