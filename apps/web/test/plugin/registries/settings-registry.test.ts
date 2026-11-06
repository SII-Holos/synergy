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

  test("retains a context factory so each Settings mount owns its lifetime", () => {
    const context = {
      pluginId: "test",
      scopeId: "scope",
      surface: { kind: "ui.settings", id: "remote" },
      operations: {},
      events: {},
      settings: {},
    } as unknown as PluginSettingsSurfaceContext
    const createContext = () => context
    const unregister = registerSettingsSection({ ...section, id: "test:context", createContext })

    expect(getSettingsSection("test:context")?.createContext).toBe(createContext)
    expect(getSettingsSection("test:context")?.createContext?.()).toBe(context)
    expect(getSettingsSection(section.id)?.createContext).toBeUndefined()
    unregister()
  })
})
