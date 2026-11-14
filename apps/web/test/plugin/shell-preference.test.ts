import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createShellPreference } from "../../src/plugin/shell-preference"

test("remembers shell selection per server without erasing a temporarily unavailable selection", () => {
  localStorage.removeItem("synergy.global.dat:plugin-shells")
  createRoot((dispose) => {
    const [server, setServer] = createSignal("https://one.test")
    const preference = createShellPreference(server)
    expect(preference.selected()).toBe("synergy")
    preference.select("plugin:main")
    setServer("https://two.test")
    expect(preference.selected()).toBe("synergy")
    preference.select("other:main")
    setServer("https://one.test")
    expect(preference.selected()).toBe("plugin:main")
    dispose()
  })
  createRoot((dispose) => {
    const preference = createShellPreference(() => "https://one.test")
    expect(preference.selected()).toBe("plugin:main")
    dispose()
  })
  localStorage.removeItem("synergy.global.dat:plugin-shells")
})

test("reads a URL-keyed selection after the runtime identity key is adopted", () => {
  localStorage.setItem(
    "synergy.global.dat:plugin-shells",
    JSON.stringify({ version: 1, servers: { "https://legacy.test": "plugin:main" } }),
  )
  createRoot((dispose) => {
    const preference = createShellPreference(
      () => '["personal","runtime"]',
      "shell",
      () => "https://legacy.test",
    )
    expect(preference.selected()).toBe("plugin:main")
    preference.select("synergy")
    expect(preference.selected()).toBe("synergy")
    dispose()
  })
  localStorage.removeItem("synergy.global.dat:plugin-shells")
})
