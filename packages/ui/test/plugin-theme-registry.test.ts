import { expect, test } from "bun:test"
import { synergyTheme } from "../src/theme/default-themes"
import {
  getPluginTheme,
  isPluginThemeRegistryReady,
  replacePluginThemes,
  subscribePluginThemes,
} from "../src/theme/plugin-theme-registry"

test("replaces a complete plugin theme generation with one notification", () => {
  let notifications = 0
  const unsubscribe = subscribePluginThemes(() => notifications++)
  try {
    replacePluginThemes([
      { id: "one:default", label: "One", theme: { ...synergyTheme, id: "default" }, pluginId: "one" },
    ])
    notifications = 0
    replacePluginThemes([
      { id: "two:default", label: "Two", theme: { ...synergyTheme, id: "default" }, pluginId: "two" },
    ])

    expect(notifications).toBe(1)
    expect(getPluginTheme("one:default")).toBeUndefined()
    expect(getPluginTheme("two:default")?.pluginId).toBe("two")
    expect(isPluginThemeRegistryReady()).toBe(true)
  } finally {
    unsubscribe()
    replacePluginThemes([])
  }
})
