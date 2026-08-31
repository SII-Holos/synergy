mock.module("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/" }),
}))

mock.module("../../src/plugin/text-action-surface", () => ({
  PluginTextActionSurface: () => null,
}))

mock.module("@/locales/en/messages.po?lingui", () => ({ messages: {} }))

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

// The bridge replays the persisted theme preference on registry/host events.
// Its regression (stale config snapshot stomping a fresh in-UI selection on
// the next event, including across bridge remounts during session
// transitions) lives in the interplay between the config resource, the theme
// store, and the recorded selection — exercised here against controllable
// fakes at the same boundaries the component consumes.
const registered = new Set<string>()
const appliedCalls: string[] = []
const [themeId, setThemeIdInternal] = createSignal("synergy")
const [hostPlugins, setHostPlugins] = createSignal<unknown[]>([{}])
const [registryTick, setRegistryTick] = createSignal(0)
let resolveConfig: ((value: { theme?: string } | undefined) => void) | undefined

function userSelects(id: string) {
  registered.add(id)
  recordThemeSelection(id)
  setThemeIdInternal(id)
}

function publishRegistryEvent() {
  setRegistryTick((tick) => tick + 1)
}

function reloadHost() {
  setHostPlugins((list) => [...list, {}])
}

mock.module("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
      config: {
        global: () =>
          new Promise((resolve) => {
            resolveConfig = (value) => resolve({ data: value })
          }),
      },
    },
  }),
}))

mock.module("@ericsanchezok/synergy-ui/theme", () => ({
  useTheme: () => ({
    themeId,
    themes: () => {
      registryTick()
      return []
    },
    setThemeId: (id: string) => {
      appliedCalls.push(id)
      if (id !== "synergy" && !registered.has(id)) return
      setThemeIdInternal(id)
    },
  }),
}))

mock.module("../../src/plugin/host", () => ({
  usePluginHost: () => ({ plugins: hostPlugins }),
}))

const { PluginThemeConfigBridge } = await import("../../src/plugin/bridge")
const { recordThemeSelection, resetThemeSelection } = await import("../../src/plugin/theme-selection")

function mountBridge(): () => void {
  let disposeRoot = () => {}
  createRoot((dispose) => {
    disposeRoot = dispose
    PluginThemeConfigBridge()
  })
  return disposeRoot
}

beforeEach(() => {
  registered.clear()
  appliedCalls.length = 0
  setThemeIdInternal("synergy")
  resolveConfig = undefined
  resetThemeSelection()
})

describe("PluginThemeConfigBridge selection replay", () => {
  test("a selection survives registry events and bridge remounts despite the stale config snapshot", async () => {
    const first = mountBridge()
    try {
      resolveConfig?.({ theme: "" })
      await Bun.sleep(20)

      // The user picks a plugin skin; SettingsPanel records it and persists
      // it server-side through a fire-and-forget PATCH.
      userSelects("plugin-a:skin")
      await Bun.sleep(20)

      // Cross-scope session switch: host reloads and the registry republishes.
      reloadHost()
      publishRegistryEvent()
      await Bun.sleep(20)

      expect(themeId()).toBe("plugin-a:skin")
      expect(appliedCalls[appliedCalls.length - 1]).toBe("plugin-a:skin")
    } finally {
      first()
    }

    // The session transition remounts the bridge; the freshly fetched config
    // still races the selection PATCH and reports the old preference. The
    // recorded selection must win over that stale snapshot.
    const second = mountBridge()
    try {
      resolveConfig?.({ theme: "" })
      await Bun.sleep(20)

      expect(themeId()).toBe("plugin-a:skin")
    } finally {
      second()
    }
  })

  test("the persisted preference applies at boot when no selection was recorded", async () => {
    registered.add("plugin-a:skin")
    const dispose = mountBridge()
    try {
      resolveConfig?.({ theme: "plugin-a:skin" })
      await Bun.sleep(20)
      expect(themeId()).toBe("plugin-a:skin")

      publishRegistryEvent()
      await Bun.sleep(20)
      expect(themeId()).toBe("plugin-a:skin")
    } finally {
      dispose()
    }
  })

  test("a selection made before the config resolves wins over the stale snapshot", async () => {
    const dispose = mountBridge()
    try {
      userSelects("plugin-b:skin")
      await Bun.sleep(20)

      // The mount-time fetch lands after the selection with the old value.
      resolveConfig?.({ theme: "plugin-a:skin" })
      await Bun.sleep(20)

      expect(themeId()).toBe("plugin-b:skin")
      publishRegistryEvent()
      await Bun.sleep(20)
      expect(themeId()).toBe("plugin-b:skin")
    } finally {
      dispose()
    }
  })

  test("selecting the default skin records and replays an empty selection", async () => {
    registered.add("plugin-a:skin")
    const dispose = mountBridge()
    try {
      resolveConfig?.({ theme: "plugin-a:skin" })
      await Bun.sleep(20)
      expect(themeId()).toBe("plugin-a:skin")
      userSelects("synergy")
      await Bun.sleep(20)
      publishRegistryEvent()
      await Bun.sleep(20)

      expect(themeId()).toBe("synergy")
      expect(appliedCalls[appliedCalls.length - 1]).toBe("synergy")
    } finally {
      dispose()
    }
  })
})
