import { describe, expect, test } from "bun:test"
import {
  getSettingsSection,
  registerSettingsSection,
  subscribeSettingsSections,
  type SettingsSection,
} from "../../../src/plugin/registries/settings-registry"

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
})
