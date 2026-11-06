import { describe, expect, test } from "bun:test"
import { normalizePluginArchiveEntry } from "@ericsanchezok/synergy-plugin"

describe("normalizePluginArchiveEntry", () => {
  test("normalizes tar listing entries from plugin archives", () => {
    expect(normalizePluginArchiveEntry("./plugin.json\r")).toBe("plugin.json")
    expect(normalizePluginArchiveEntry("./runtime/index.js\r")).toBe("runtime/index.js")
    expect(normalizePluginArchiveEntry("runtime/")).toBe("runtime")
    expect(normalizePluginArchiveEntry("icons\\market.svg")).toBe("icons/market.svg")
  })

  test("skips empty and root directory entries", () => {
    expect(normalizePluginArchiveEntry("")).toBeUndefined()
    expect(normalizePluginArchiveEntry(".")).toBeUndefined()
    expect(normalizePluginArchiveEntry("./")).toBeUndefined()
  })

  test("rejects paths that escape the plugin root", () => {
    expect(() => normalizePluginArchiveEntry("../plugin.json")).toThrow("cannot escape")
    expect(() => normalizePluginArchiveEntry("/plugin.json")).toThrow("must be relative")
    expect(() => normalizePluginArchiveEntry("C:\\x\\plugin.json")).toThrow("must be relative")
  })
})
