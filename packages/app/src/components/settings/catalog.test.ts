import { describe, expect, test } from "bun:test"
import {
  BUILTIN_SETTINGS_IDS,
  BUILTIN_SETTINGS_SECTIONS,
  FIELD_SAVE_STRATEGY,
  SETTINGS_GROUP_ORDER,
  settingsGroupOrder,
} from "./catalog"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

const canonicalDomains = [
  "general",
  "models",
  "providers",
  "library",
  "mcp",
  "plugins",
  "agents",
  "commands",
  "permissions",
  "channels",
  "holos",
  "email",
  "runtime",
]

describe("settings catalog", () => {
  test("defines the built-in sections in the requested order", () => {
    expect(BUILTIN_SETTINGS_SECTIONS.map((section) => section.id)).toEqual([...BUILTIN_SETTINGS_IDS])
    expect(SETTINGS_GROUP_ORDER).toEqual([
      "Personal",
      "Core",
      "Library",
      "Agents",
      "Integrations",
      "Safety",
      "Runtime",
      "System",
    ])
  })

  test("visible built-in labels do not use ampersand pairing", () => {
    for (const section of BUILTIN_SETTINGS_SECTIONS) {
      expect(section.label.includes("&")).toBe(false)
      expect(section.group.includes("&")).toBe(false)
    }
  })

  test("all canonical config domains are discoverable", () => {
    const discovered = new Set(BUILTIN_SETTINGS_SECTIONS.flatMap((section) => section.domainIds))
    for (const domain of canonicalDomains) {
      expect(discovered.has(domain)).toBe(true)
    }
  })

  test("search metadata covers keywords and row labels", () => {
    const general = BUILTIN_SETTINGS_SECTIONS.find((section) => section.id === "general")!
    expect(general.keywords).toContain("toast")
    expect(general.rowLabels).toContain("Auto Update")
    const compaction = BUILTIN_SETTINGS_SECTIONS.find((section) => section.id === "compaction")!
    expect(compaction.rowLabels).toContain("Overflow Threshold")
  })

  test("all built-in icon tokens resolve", () => {
    for (const section of BUILTIN_SETTINGS_SECTIONS) {
      expect(getSemanticIcon(section.iconToken)).toBeTruthy()
    }
  })

  test("field save strategies are metadata-only and cover editable fields", () => {
    expect(FIELD_SAVE_STRATEGY.snapshot).toBe("auto")
    expect(FIELD_SAVE_STRATEGY.controlProfile).toBe("explicit")
    expect(FIELD_SAVE_STRATEGY.email).toBe("explicit")
  })

  test("unknown groups sort after built-ins for plugin compatibility", () => {
    expect(settingsGroupOrder("Personal")).toBe(0)
    expect(settingsGroupOrder("Plugin Group")).toBeGreaterThan(settingsGroupOrder("System"))
  })
})
