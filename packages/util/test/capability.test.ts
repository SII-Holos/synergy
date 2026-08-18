import { describe, expect, test } from "bun:test"
import {
  SYNERGY_CAPABILITY_CATEGORIES,
  SYNERGY_CAPABILITY_DETAILS,
  SYNERGY_PERMISSION_CAPABILITY,
  SYNERGY_PROFILE_CAPABILITIES,
  capabilityNonBypassable,
  capabilityRisk,
  permissionCapability,
  permissionCategoryForKey,
} from "../src/capability"

describe("capability metadata", () => {
  test("every detail uses a declared category and severity", () => {
    const categories = new Set(SYNERGY_CAPABILITY_CATEGORIES)
    const severities = new Set(["low", "medium", "high"])
    for (const [name, definition] of Object.entries(SYNERGY_CAPABILITY_DETAILS)) {
      expect(definition.title).toBeTruthy()
      expect(definition.description).toBeTruthy()
      expect(categories.has(definition.category)).toBe(true)
      expect(severities.has(definition.severity)).toBe(true)
      expect(SYNERGY_CAPABILITY_DETAILS[name]).toBe(definition)
    }
  })

  test("all profile capabilities have detail entries", () => {
    for (const capability of SYNERGY_PROFILE_CAPABILITIES) {
      expect(SYNERGY_CAPABILITY_DETAILS[capability]).toBeDefined()
    }
  })

  test("every permission mapping resolves to a detail entry", () => {
    for (const capability of new Set(Object.values(SYNERGY_PERMISSION_CAPABILITY))) {
      expect(SYNERGY_CAPABILITY_DETAILS[capability]).toBeDefined()
    }
  })
})

describe("permissionCapability", () => {
  test("maps registered permissions to their capability", () => {
    expect(permissionCapability("read")).toBe("file_read")
    expect(permissionCapability("bash")).toBe("shell")
    expect(permissionCapability("webfetch")).toBe("network_read")
    expect(permissionCapability("secrets")).toBe("secrets")
  })

  test("passes unknown permissions through unchanged", () => {
    expect(permissionCapability("custom_plugin_action")).toBe("custom_plugin_action")
  })
})

describe("capabilityNonBypassable", () => {
  test("reflects the declared nonBypassable flag", () => {
    expect(capabilityNonBypassable("shell_destructive")).toBe(true)
    expect(capabilityNonBypassable("secrets")).toBe(true)
    expect(capabilityNonBypassable("file_read")).toBe(false)
    expect(capabilityNonBypassable("unknown_capability")).toBe(false)
  })
})

describe("capabilityRisk", () => {
  test("returns the declared severity", () => {
    expect(capabilityRisk("file_read")).toBe("low")
    expect(capabilityRisk("shell")).toBe("medium")
    expect(capabilityRisk("shell_destructive")).toBe("high")
  })

  test("defaults unknown capabilities to high", () => {
    expect(capabilityRisk("unknown_capability")).toBe("high")
  })
})

describe("permissionCategoryForKey", () => {
  test("returns the category for declared capabilities", () => {
    expect(permissionCategoryForKey("shell")).toBe("runtime")
    expect(permissionCategoryForKey("file_read")).toBe("files")
    expect(permissionCategoryForKey("browser_interact")).toBe("browser")
  })

  test("classifies unknown prefixed keys", () => {
    expect(permissionCategoryForKey("ui.some_toggle")).toBe("ui")
    expect(permissionCategoryForKey("hooks.some_hook")).toBe("hooks")
    expect(permissionCategoryForKey("data.some_store")).toBe("data")
    expect(permissionCategoryForKey("runtime.some_switch")).toBe("runtime")
    expect(permissionCategoryForKey("session.some_state")).toBe("session")
    expect(permissionCategoryForKey("browser.some_flag")).toBe("browser")
  })

  test("falls back to tools", () => {
    expect(permissionCategoryForKey("anything_else")).toBe("tools")
  })
})
