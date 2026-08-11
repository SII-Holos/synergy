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

  test("discard restores the last saved values", () => {
    const drafts = createPluginSettingsDrafts()
    drafts.adopt(alpha, { enabled: false })
    drafts.stage(alpha, { enabled: true })

    drafts.discard()

    expect(drafts.values(alpha)).toEqual({ enabled: false })
    expect(drafts.dirty()).toBe(false)
  })
})
