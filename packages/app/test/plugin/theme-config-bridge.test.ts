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
// Its regressions (a stale config snapshot stomping a fresh selection, one
// server's selection suppressing another server's preference, and a
// definitively uninstalled theme staying degraded forever) live in the
// interplay between the config resource, the theme store, and the recorded
// selection — exercised here against controllable fakes at the same
// boundaries the component consumes.
const SERVER_A = "http://server-a.local"
const SERVER_B = "http://server-b.local"
const registered = new Set<string>()
const appliedCalls: string[] = []
const [themeId, setThemeIdInternal] = createSignal("synergy")
const [themeChoices, setThemeChoices] = createSignal<{ id: string }[]>([{ id: "synergy" }])
const [hostPlugins, setHostPlugins] = createSignal<unknown[]>([{}])
const [registryTick, setRegistryTick] = createSignal(0)
let sdkUrl = SERVER_A
// Mirrors the generated SDK contract: responses wrap their payload in `data`.
let fetchConfig: () => Promise<{ data: { theme?: string } | undefined } | undefined> = async () => undefined

function userSelects(id: string) {
  registered.add(id)
  recordThemeSelection(sdkUrl, id)
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
    get url() {
      return sdkUrl
    },
    client: {
      config: {
        global: () => fetchConfig(),
      },
    },
  }),
}))

mock.module("@ericsanchezok/synergy-ui/theme", () => ({
  useTheme: () => ({
    themeId,
    themes: () => {
      registryTick()
      return themeChoices()
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
const { recordThemeSelection, settleThemeSelection, readThemeSelection, resetThemeSelection } = await import(
  "../../src/plugin/theme-selection"
)

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
  setThemeChoices([{ id: "synergy" }])
  sdkUrl = SERVER_A
  fetchConfig = async () => undefined
  resetThemeSelection(SERVER_A)
  resetThemeSelection(SERVER_B)
})

describe("PluginThemeConfigBridge selection replay", () => {
  test("a selection survives registry events and bridge remounts despite the stale config snapshot", async () => {
    fetchConfig = async () => ({ data: { theme: "" } })
    const first = mountBridge()
    try {
      await Bun.sleep(20)

      // The user picks a plugin skin; SettingsPanel records it and settles its
      // fire-and-forget persistence.
      userSelects("plugin-a:skin")
      setThemeChoices([{ id: "synergy" }, { id: "plugin-a:skin" }])
      settleThemeSelection(SERVER_A, "plugin-a:skin", true)
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

    // The session transition remounts the bridge; its fresh config fetch
    // still reports the old preference. The recorded selection must win.
    const second = mountBridge()
    try {
      await Bun.sleep(20)
      expect(themeId()).toBe("plugin-a:skin")
    } finally {
      second()
    }
  })

  test("the persisted preference applies at boot when no selection was recorded", async () => {
    registered.add("plugin-a:skin")
    setThemeChoices([{ id: "synergy" }, { id: "plugin-a:skin" }])
    fetchConfig = async () => ({ data: { theme: "plugin-a:skin" } })
    const dispose = mountBridge()
    try {
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
    let releaseConfig: ((value: { data: { theme?: string } }) => void) | undefined
    fetchConfig = () => new Promise((resolve) => (releaseConfig = resolve))
    const dispose = mountBridge()
    try {
      userSelects("plugin-b:skin")
      setThemeChoices([{ id: "synergy" }, { id: "plugin-b:skin" }])
      await Bun.sleep(20)

      // The mount-time fetch lands after the selection with the old value.
      releaseConfig?.({ data: { theme: "plugin-a:skin" } })
      await Bun.sleep(20)

      expect(themeId()).toBe("plugin-b:skin")
      publishRegistryEvent()
      await Bun.sleep(20)
      expect(themeId()).toBe("plugin-b:skin")
    } finally {
      dispose()
    }
  })

  test("a definitively removed theme drops the record and applies the cleared preference", async () => {
    fetchConfig = async () => ({ data: { theme: "plugin-a:skin" } })
    const dispose = mountBridge()
    try {
      await Bun.sleep(20)
      userSelects("plugin-a:skin")
      setThemeChoices([{ id: "synergy" }, { id: "plugin-a:skin" }])
      settleThemeSelection(SERVER_A, "plugin-a:skin", true)
      await Bun.sleep(20)
      // The theme plugin is uninstalled: the server-side uninstall clears
      // the preference BEFORE the catalog drops the plugin, so the bridge's
      // refetch can only ever observe the cleared value once the registry
      // loses the theme.
      let fetches = 0
      fetchConfig = async () => {
        fetches++
        return { data: { theme: "" } }
      }
      setThemeChoices([{ id: "synergy" }])
      publishRegistryEvent()
      await Bun.sleep(40)

      expect(themeId()).toBe("synergy")
      expect(readThemeSelection(SERVER_A)).toBeUndefined()
      expect(appliedCalls[appliedCalls.length - 1]).toBe("synergy")
      expect(fetches).toBeGreaterThanOrEqual(1)
    } finally {
      dispose()
    }
  })

  test("a transient registry gap refetches the preference once without looping", async () => {
    let fetches = 0
    fetchConfig = async () => {
      fetches++
      return { data: { theme: "plugin-a:skin" } }
    }
    const dispose = mountBridge()
    try {
      await Bun.sleep(20)
      userSelects("plugin-a:skin")
      setThemeChoices([{ id: "synergy" }, { id: "plugin-a:skin" }])
      settleThemeSelection(SERVER_A, "plugin-a:skin", true)
      await Bun.sleep(20)

      // Registry gap (e.g. server restart, scope not yet activated): the
      // theme is missing but the preference still backs it.
      setThemeChoices([{ id: "synergy" }])
      publishRegistryEvent()
      await Bun.sleep(40)
      expect(fetches).toBe(2)

      // Further registry events do not keep refetching the same gap.
      publishRegistryEvent()
      await Bun.sleep(40)
      expect(fetches).toBe(2)
      expect(themeId()).toBe("plugin-a:skin")
    } finally {
      dispose()
    }
  })

  test("the recorded selection does not leak across a server change", async () => {
    fetchConfig = async () => ({ data: { theme: "" } })
    const first = mountBridge()
    try {
      await Bun.sleep(20)
      userSelects("plugin-a:skin")
      setThemeChoices([{ id: "synergy" }, { id: "plugin-a:skin" }])
      settleThemeSelection(SERVER_A, "plugin-a:skin", true)
      await Bun.sleep(20)
      expect(themeId()).toBe("plugin-a:skin")
    } finally {
      first()
    }

    // Server switch: the record is keyed to server A, so server B's persisted
    // preference (a built-in skin) applies instead.
    sdkUrl = SERVER_B
    registered.add("catppuccin")
    setThemeChoices([{ id: "synergy" }, { id: "catppuccin" }])
    fetchConfig = async () => ({ data: { theme: "catppuccin" } })
    const second = mountBridge()
    try {
      await Bun.sleep(20)
      expect(themeId()).toBe("catppuccin")
      expect(readThemeSelection(SERVER_A)?.id).toBe("plugin-a:skin")
    } finally {
      second()
    }
  })
})
