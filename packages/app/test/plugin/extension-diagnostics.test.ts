import { expect, test } from "bun:test"
import { pluginExtensionTarget } from "../../src/plugin/extension-diagnostics"
import { registerSkin, getSkin, listSkins, subscribeSkins } from "../../src/plugin/registries/skin-registry"
import { parseSkin } from "@ericsanchezok/synergy-plugin/skin"

test("extension diagnostics identify presentation targets without misreporting data contributions", () => {
  expect(
    pluginExtensionTarget({ kind: "ui.settings", id: "settings", label: "Settings", group: "general", order: 0 }),
  ).toBe("settings.section")
  expect(
    pluginExtensionTarget({
      kind: "ui.navigationItem",
      id: "page",
      label: "Page",
      placement: "sidebar",
      order: 0,
      component: { entry: "ui.js", exportName: "Page" },
    }),
  ).toBe("navigation.sidebar")
  expect(
    pluginExtensionTarget({
      kind: "ui.menu",
      order: 0,
      id: "menu",
      command: "run",
      location: "session.header.actions",
    }),
  ).toBe("session.header.actions")
  expect(pluginExtensionTarget({ kind: "ui.theme", id: "theme", label: "Theme", path: "theme.json" })).toBeUndefined()
})

test("skin registration removal restores availability and releases observers", () => {
  let changes = 0
  const stop = subscribeSkins(() => changes++)
  const id = "fixture:skin"
  const remove = registerSkin({
    id,
    label: "Fixture",
    pluginId: "fixture",
    definition: parseSkin({
      version: 1,
      id: "skin",
      light: {},
      dark: {},
      narrow: {},
      reducedMotion: { decorations: "hide" },
    }),
    assets: {},
  })
  expect(getSkin(id)?.pluginId).toBe("fixture")
  expect(listSkins().some((skin) => skin.id === id)).toBe(true)
  remove()
  expect(getSkin(id)).toBeUndefined()
  expect(changes).toBe(2)
  stop()
})
