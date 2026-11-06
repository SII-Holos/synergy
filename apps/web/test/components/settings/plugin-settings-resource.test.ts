import { describe, expect, test } from "bun:test"
import { pluginSettingsResourceKey } from "../../../src/components/settings/plugin-settings-resource"

describe("plugin settings resource", () => {
  test("includes Scope identity when keying the same plugin", () => {
    expect(pluginSettingsResourceKey({ pluginId: "frontend-kit", scopeId: "scope-one" })).toEqual({
      pluginId: "frontend-kit",
      scopeId: "scope-one",
    })
    expect(pluginSettingsResourceKey({ pluginId: "frontend-kit", scopeId: "scope-two" })).toEqual({
      pluginId: "frontend-kit",
      scopeId: "scope-two",
    })
    expect(pluginSettingsResourceKey({ pluginId: "frontend-kit" })).toBeUndefined()
  })
})
