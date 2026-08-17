import { expect, test } from "bun:test"
import { builtinThemes, synergyTheme } from "../src/theme/default-themes"
import {
  getPluginTheme,
  getTheme,
  isPluginThemeRegistryReady,
  listThemeChoices,
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
    replacePluginThemes([], { ready: false })
  }
})

test("built-in skin ids cannot be shadowed by plugin themes", () => {
  replacePluginThemes([
    { id: "catppuccin", label: "Plugin Catppuccin", theme: { ...synergyTheme, id: "catppuccin" }, pluginId: "one" },
    { id: "one:default", label: "One", theme: { ...synergyTheme, id: "default" }, pluginId: "one" },
  ])
  try {
    expect(getPluginTheme("catppuccin")).toBeUndefined()
    expect(getTheme("catppuccin")?.builtin).toBe(true)
    expect(listThemeChoices().map((theme) => theme.id)).toEqual([
      ...builtinThemes.map((theme) => theme.id),
      "one:default",
    ])
  } finally {
    replacePluginThemes([], { ready: false })
  }
})

test("empty cleanup replace marks the registry unready without losing the generation signal on next load", () => {
  replacePluginThemes([{ id: "one:default", label: "One", theme: { ...synergyTheme, id: "default" }, pluginId: "one" }])
  expect(isPluginThemeRegistryReady()).toBe(true)

  replacePluginThemes([], { ready: false })
  expect(isPluginThemeRegistryReady()).toBe(false)
  expect(getPluginTheme("one:default")).toBeUndefined()

  replacePluginThemes([{ id: "two:default", label: "Two", theme: { ...synergyTheme, id: "default" }, pluginId: "two" }])
  expect(isPluginThemeRegistryReady()).toBe(true)
  expect(getPluginTheme("two:default")?.pluginId).toBe("two")

  replacePluginThemes([], { ready: false })
})
