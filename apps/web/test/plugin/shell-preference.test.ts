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
