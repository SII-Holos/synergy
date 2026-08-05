import { describe, expect, test } from "bun:test"
import {
  getSettingsSection,
  registerSettingsSection,
  subscribeSettingsSections,
  type SettingsSection,
} from "../../../src/plugin/registries/settings-registry"
import type { PluginSettingsSurfaceContext } from "@ericsanchezok/synergy-plugin"

const section: SettingsSection = {
  id: "test:reactive-settings",
  label: "Reactive settings",
  group: "Plugins",
  pluginId: "test",
}

describe("settings registry", () => {
  test("notifies open settings consumers when plugin sections change", () => {
    const observed: Array<SettingsSection | undefined> = []
    const unsubscribe = subscribeSettingsSections(() => observed.push(getSettingsSection(section.id)))
    const unregister = registerSettingsSection(section)

    unregister()
    unsubscribe()

    expect(observed).toEqual([section, undefined])
  })

  test("preserves the trusted Settings surface context without requiring it from legacy sections", () => {
    const context = {
      pluginId: "test",
      scopeId: "scope",
      surface: { kind: "ui.settings", id: "remote" },
      operations: {},
      events: {},
      settings: {},
      host: {},
    } as unknown as PluginSettingsSurfaceContext
    const unregister = registerSettingsSection({ ...section, id: "test:context", context })

    expect(getSettingsSection("test:context")?.context).toBe(context)
    expect(getSettingsSection(section.id)?.context).toBeUndefined()
    unregister()
  })
})
