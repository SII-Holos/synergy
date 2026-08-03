import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const settingsDir = join(import.meta.dir, "../../../../src/components/settings")
const primitives = readFileSync(join(settingsDir, "components/SettingsMenuField.tsx"), "utf8")
const css = readFileSync(join(settingsDir, "settings-panel.css"), "utf8")

describe("SettingsMenuField primitive", () => {
  test("exposes a generic option type keyed by value", () => {
    expect(primitives).toContain("export type SettingsMenuOption<T extends string>")
    expect(primitives).toContain("value: T")
    expect(primitives).toContain("label: string")
  })

  test("renders a pill trigger and a Kobalte popover menu", () => {
    expect(primitives).toContain("KobaltePopover.Trigger")
    expect(primitives).toContain('class="settings-menu-field-trigger"')
    expect(primitives).toContain("KobaltePopover.Content")
    expect(primitives).toContain('class="settings-menu-field-surface')
    expect(primitives).toContain('class="settings-menu-field-item"')
    expect(primitives).toContain('classList={{ "is-active":')
  })

  test("keeps the active option marked with a success icon", () => {
    expect(primitives).toContain('getSemanticIcon("state.success")')
  })

  test("supports an optional count badge per option", () => {
    expect(primitives).toContain("count?: number")
    expect(primitives).toContain("settings-menu-field-count")
  })

  test("portals into the settings popover layer when provided", () => {
    expect(primitives).toContain("popoverLayer?: HTMLElement")
    expect(primitives).toContain("<Portal mount={layer()}>")
  })
})

describe("SettingsMenuField styles", () => {
  test("defines trigger, surface, item, and count styles", () => {
    expect(css).toContain(".settings-menu-field-trigger")
    expect(css).toContain(".settings-menu-field-surface")
    expect(css).toContain(".settings-menu-field-item")
    expect(css).toContain(".settings-menu-field-item.is-active")
    expect(css).toContain(".settings-menu-field-count")
  })

  test("uses semantic type tokens instead of naked pixel font sizes", () => {
    expect(css).toContain("font-size: var(--settings-type-control-size)")
    expect(css).toContain("font-size: var(--settings-type-body-size)")
    expect(css).toContain("font-size: var(--settings-type-caption-size)")
  })

  test("keeps the menu surface clickable inside the pointer-events-none layer", () => {
    expect(css).toContain(".settings-popover-layer .settings-menu-field-surface")
    expect(css).toContain("pointer-events: auto")
  })
})

describe("settings panels use the shared menu field", () => {
  const panelNames = [
    "CodeChecksPanel.tsx",
    "GeneralPanel.tsx",
    "RuntimePanels.tsx",
    "ImportPanel.tsx",
    "ArchivedSessionsPanel.tsx",
    "library-embedding-section.tsx",
  ]
  for (const name of panelNames) {
    test(`${name} replaces native selects with SettingsMenuField`, () => {
      const source = readFileSync(join(settingsDir, "panels", name), "utf8")
      expect(source).toContain("SettingsMenuField")
      expect(source).not.toMatch(/<select\b/)
      expect(source).not.toContain("settings-select")
    })
  }
})
