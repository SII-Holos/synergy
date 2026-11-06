import { afterEach, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import { createBrowserSettingsCapability } from "../../../src/components/settings/browser-settings-capability"
import { BUILTIN_SETTINGS_SECTIONS } from "../../../src/components/settings/catalog"
import { runtimeFeatureAvailable } from "../../../src/components/runtime-features"

const disposers: VoidFunction[] = []
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("Browser settings has no preference domain and follows General in personal preferences", () => {
  const browser = BUILTIN_SETTINGS_SECTIONS.find((section) => section.id === "browser")!
  const general = BUILTIN_SETTINGS_SECTIONS.find((section) => section.id === "general")!
  expect(browser).toMatchObject({ label: "Browser", domainIds: [], groupKey: "personal", iconToken: "browser.main" })
  expect(browser.order).toBeGreaterThan(general.order)
  expect(browser.rowLabels).toEqual(["Import browser data", "Manage saved passwords"])
  expect(runtimeFeatureAvailable("settings", "browser", () => false)).toBe(false)
})

test("unknown and absent Browser capability make zero native requests, reconnect rejects stale authority", async () => {
  let calls = 0
  const held = Promise.withResolvers<{
    protocolVersion: typeof BROWSER_PROTOCOL_VERSION
    managedLocal: boolean
    status: "ready"
  }>()
  const f = createRoot((dispose) => {
    disposers.push(dispose)
    const [selection, setSelection] = createSignal<object>()
    const [selected, setSelected] = createSignal(false)
    const capability = createBrowserSettingsCapability({
      selection,
      selected,
      serverUrl: () => "http://fixture.test",
      bridge: () => ({
        profileDataAction: async () => ({ type: "done" }),
        presentationCapability: async () => {
          calls++
          return held.promise
        },
      }),
    })
    return { capability, setSelection, setSelected }
  })
  await tick()
  expect(f.capability.visible()).toBe(false)
  expect(calls).toBe(0)
  f.setSelection({})
  await tick()
  expect(calls).toBe(0)
  f.setSelected(true)
  await tick()
  expect(calls).toBe(1)
  f.setSelection(undefined)
  f.setSelected(false)
  held.resolve({ protocolVersion: BROWSER_PROTOCOL_VERSION, managedLocal: true, status: "ready" })
  await tick()
  expect(f.capability.visible()).toBe(false)
})

test("managed-local reconnecting broker retains Browser settings with local retry state", async () => {
  const f = createRoot((dispose) => {
    disposers.push(dispose)
    return createBrowserSettingsCapability({
      selection: () => selectedRuntime,
      selected: () => true,
      serverUrl: () => "http://fixture.test",
      bridge: () => ({
        profileDataAction: async () => ({ type: "done" }),
        presentationCapability: async () => ({
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          managedLocal: true,
          status: "restarting",
        }),
      }),
    })
  })
  await tick()
  expect(f.visible()).toBe(true)
  expect(f.ready()).toBe(false)
})
const selectedRuntime = {}
