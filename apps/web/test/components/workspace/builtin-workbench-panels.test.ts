import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { clearWorkbenchPanels, listWorkbenchPanels } from "../../../src/plugin/registries/workbench-panel-registry"

// bun's test transform compiles JSX to React.createElement in this harness.
// The provider's own JSX (return <>{props.children}</>, tabIcon FileIcon) is
// never rendered here — we drive the provider as a plain function inside
// createRoot so its registration effect runs — so a minimal React shim is
// enough for the compiled createElement calls.
;(globalThis as unknown as { React: unknown }).React = {
  createElement: () => null,
  Fragment: Symbol("Fragment"),
}

const [selected, setSelected] = createSignal<string[] | undefined>()
mock.module("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({ capabilities: { has: (id: string) => selected()?.includes(id) ?? true } }),
}))

const [activeLocale, setActiveLocale] = createSignal("en")
mock.module("@solidjs/router", () => ({
  useParams: () => ({ dir: "home", id: "session-one" }),
  useNavigate: () => () => {},
}))
mock.module("@/context/sdk", () => ({
  useSDK: () => ({ scopeID: "home", scopeKey: "home", url: "http://localhost", client: { browser: {} } }),
}))
const [nativeBrowser, setNativeBrowser] = createSignal(true)
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    get browserNative() {
      return nativeBrowser() ? {} : undefined
    },
  }),
}))
mock.module("@/context/workbench", () => ({ useWorkbenchPanels: () => ({ surface: () => ({ tabs: () => [] }) }) }))

mock.module("@/context/terminal", () => ({
  useTerminal: () => ({ new: async () => undefined, all: () => [], close: async () => {} }),
}))
mock.module("@/context/file", () => ({
  useProjectFiles: () => ({ roots: () => [], search: async () => [], open: async () => {} }),
  useFile: () => ({ explorer: { setOpen: () => {} } }),
}))
mock.module("@/context/locale", () => ({
  useLocale: () => ({
    controller: { activeLocale },
    i18n: {
      _: (descriptor: { id: string; message?: string }) => descriptor.message ?? descriptor.id,
    },
  }),
}))

mock.module("@/components/note/documents", () => ({
  useNoteDocuments: () => ({ get: () => ({ flush: async () => true }) }),
}))
mock.module("../../../src/components/workspace/browser/browser-catalog", () => ({ useBrowserCatalog: () => ({}) }))

const { BuiltinWorkbenchPanelsProvider } = await import("../../../src/components/workspace/builtin-workbench-panels")

const BUILTIN_PANEL_IDS = [
  "resource-home",
  "notes",
  "context",
  "session-review",
  "execution-detail",
  "lattice",
  "boss",
  "attachment",
  "file",
  "browser",
  "terminal",
]

function panelIds(): string[] {
  return listWorkbenchPanels().map((panel) => panel.id)
}

afterEach(() => {
  clearWorkbenchPanels()
  setSelected(undefined)
  setNativeBrowser(true)
})

describe("built-in workbench panels", () => {
  test("Browser registration requires both the native bridge and the runtime capability", async () => {
    setSelected(["browser-runtime"])
    setNativeBrowser(false)
    const dispose = createRoot((done) => {
      BuiltinWorkbenchPanelsProvider({ children: null })
      return done
    })
    try {
      await Bun.sleep(1)
      expect(panelIds()).not.toContain("browser")
      setNativeBrowser(true)
      await Bun.sleep(1)
      expect(panelIds()).toContain("browser")
      setSelected([])
      await Bun.sleep(1)
      expect(panelIds()).not.toContain("browser")
      setSelected(["browser-runtime"])
      await Bun.sleep(1)
      expect(panelIds()).toContain("browser")
      setNativeBrowser(false)
      await Bun.sleep(1)
      expect(panelIds()).not.toContain("browser")
    } finally {
      dispose()
    }
  })

  test("each explicit new resource tab gets an independent empty slot", () => {
    const dispose = createRoot((done) => {
      BuiltinWorkbenchPanelsProvider({ children: null })
      return done
    })
    try {
      expect(listWorkbenchPanels().find((panel) => panel.id === "resource-home")?.cardinality).toBe("multi")
    } finally {
      dispose()
    }
  })

  test("registers only selected optional panels and removes them after reconnection", async () => {
    setSelected(["note"])
    const dispose = createRoot((done) => {
      BuiltinWorkbenchPanelsProvider({ children: null })
      return done
    })
    try {
      await Bun.sleep(1)
      expect(panelIds().includes("notes")).toBe(true)
      expect(panelIds().includes("browser")).toBe(false)
      expect(panelIds().includes("boss")).toBe(false)
      expect(panelIds().includes("file")).toBe(true)
      expect(listWorkbenchPanels().find((panel) => panel.id === "execution-detail")).toMatchObject({
        surface: "side",
        cardinality: "singleton",
        requiresSession: true,
        launchable: false,
        loader: expect.any(Function),
      })
      setSelected(["browser-runtime"])
      await Bun.sleep(1)
      expect(panelIds().includes("notes")).toBe(false)
      expect(panelIds().includes("browser")).toBe(true)
      expect(listWorkbenchPanels().find((panel) => panel.id === "browser")?.cardinality).toBe("multi")
    } finally {
      dispose()
    }
  })
  test("re-registers on locale change without duplicate-id throws", async () => {
    const dispose = createRoot((done) => {
      BuiltinWorkbenchPanelsProvider({ children: null })
      return done
    })
    try {
      for (let attempt = 0; attempt < 20 && panelIds().length < BUILTIN_PANEL_IDS.length; attempt++) {
        await Bun.sleep(1)
      }
      expect(panelIds().toSorted()).toEqual([...BUILTIN_PANEL_IDS].toSorted())

      // Simulate a runtime language switch: the registration effect re-runs
      // and re-registers the same panel ids. Before the fix this threw
      // "Duplicate slot entry" because the previous disposers were only run
      // after the new registrations.
      setActiveLocale("zh-CN")
      for (let attempt = 0; attempt < 20; attempt++) {
        await Bun.sleep(1)
        const ids = panelIds()
        if (ids.length === BUILTIN_PANEL_IDS.length && ids.filter((id) => id === "notes").length === 1) break
      }
      expect(panelIds().toSorted()).toEqual([...BUILTIN_PANEL_IDS].toSorted())
      expect(new Set(panelIds()).size).toBe(panelIds().length)
    } finally {
      dispose()
    }
  })
})
