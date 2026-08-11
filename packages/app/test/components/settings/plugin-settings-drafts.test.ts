import { describe, expect, test } from "bun:test"
import { createPluginSettingsDrafts } from "../../../src/components/settings/plugin-settings-drafts"

const alpha = { pluginId: "alpha", scopeId: "scope-one" }
const beta = { pluginId: "beta", scopeId: "scope-one" }

describe("plugin settings drafts", () => {
  test("stages edits without writing and saves only dirty plugins", async () => {
    const drafts = createPluginSettingsDrafts()
    const writes: Array<{ pluginId: string; values: Record<string, unknown> }> = []

    drafts.adopt(alpha, { enabled: false })
    drafts.adopt(beta, { level: 1 })
    drafts.stage(alpha, { enabled: true })

    expect(drafts.dirty()).toBe(true)
    expect(writes).toEqual([])

    expect(
      await drafts.save(async (key, values) => {
        writes.push({ pluginId: key.pluginId, values })
        return values
      }),
    ).toBe(true)

    expect(writes).toEqual([{ pluginId: "alpha", values: { enabled: true } }])
    expect(drafts.dirty()).toBe(false)
  })

  test("keeps failed entries dirty while successful entries stay saved", async () => {
    const drafts = createPluginSettingsDrafts()
    const writes: string[] = []

    drafts.adopt(alpha, { enabled: false })
    drafts.adopt(beta, { level: 1 })
    drafts.stage(alpha, { enabled: true })
    drafts.stage(beta, { level: 2 })

    expect(
      await drafts.save(async (key, values) => {
        writes.push(key.pluginId)
        if (key.pluginId === "beta") throw new Error("write failed")
        return values
      }),
    ).toBe(false)
    expect(drafts.dirty()).toBe(true)

    writes.length = 0
    expect(
      await drafts.save(async (key, values) => {
        writes.push(key.pluginId)
        return values
      }),
    ).toBe(true)

    expect(writes).toEqual(["beta"])
    expect(drafts.dirty()).toBe(false)
  })

  test("serializes dirty plugin writes", async () => {
    const drafts = createPluginSettingsDrafts()
    const first = deferred<Record<string, unknown>>()
    const writes: string[] = []

    drafts.adopt(alpha, { enabled: false })
    drafts.adopt(beta, { level: 1 })
    drafts.stage(alpha, { enabled: true })
    drafts.stage(beta, { level: 2 })

    const saving = drafts.save(async (key, values) => {
      writes.push(key.pluginId)
      if (key.pluginId === "alpha") return first.promise
      return values
    })
    await Promise.resolve()

    expect(writes).toEqual(["alpha"])
    first.resolve({ enabled: true })
    expect(await saving).toBe(true)
    expect(writes).toEqual(["alpha", "beta"])
  })

  test("retains a newer draft staged while its save is in flight", async () => {
    const drafts = createPluginSettingsDrafts()
    const pending = deferred<Record<string, unknown>>()

    drafts.adopt(alpha, { level: 1 })
    drafts.stage(alpha, { level: 2 })

    const saving = drafts.save(async () => pending.promise)
    await Promise.resolve()
    drafts.stage(alpha, { level: 3 })
    pending.resolve({ level: 2 })

    expect(await saving).toBe(true)
    expect(drafts.values(alpha)).toEqual({ level: 3 })
    expect(drafts.dirty()).toBe(true)
  })

  test("retains a newer draft when an in-flight save fails", async () => {
    const drafts = createPluginSettingsDrafts()
    const pending = deferred<Record<string, unknown>>()

    drafts.adopt(alpha, { level: 1 })
    drafts.stage(alpha, { level: 2 })

    const saving = drafts.save(async () => pending.promise)
    await Promise.resolve()
    drafts.stage(alpha, { level: 3 })
    pending.reject(new Error("write failed"))

    expect(await saving).toBe(false)
    expect(drafts.values(alpha)).toEqual({ level: 3 })
    expect(drafts.dirty()).toBe(true)
  })

  test("discard restores the last saved values", () => {
    const drafts = createPluginSettingsDrafts()
    drafts.adopt(alpha, { enabled: false })
    drafts.stage(alpha, { enabled: true })

    drafts.discard()

    expect(drafts.values(alpha)).toEqual({ enabled: false })
    expect(drafts.dirty()).toBe(false)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
