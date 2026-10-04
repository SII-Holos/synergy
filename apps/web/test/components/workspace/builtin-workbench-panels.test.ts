import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  clearWorkbenchPanels,
  listWorkbenchPanels,
  type WorkbenchPanelOpenContext,
  type WorkbenchPanelTab,
} from "../../../src/plugin/registries/workbench-panel-registry"
import type { BrowserWorkbenchOpenSelection } from "../../../src/components/workspace/browser/browser-workbench-api"

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
const pages: Array<{ id: string; title: string; url: string; status: "active" | "suspended"; profileId: string }> = []
const creates: Array<() => void> = []
const closes: Array<() => void> = []
let nativeOpens = 0
let resumeFailure = false
const requests: Array<string | undefined> = []
const browserRoute = {
  mode: "scope" as const,
  scopeID: "home",
  path_directory: "home",
  ownerKey: "scope-home",
  serverUrl: "http://localhost",
}
mock.module("../../../src/components/workspace/browser/browser-catalog", () => ({
  useBrowserCatalog: () => ({
    get: async () => ({ route: browserRoute, store: { session: { pages } } }),
    refresh: async () => {},
  }),
}))
mock.module("../../../src/components/workspace/browser/browser-workbench-api", () => ({
  openBrowserWorkbenchPage: async (input: {
    restore?: boolean
    requestId?: string
    selection?: BrowserWorkbenchOpenSelection
    onCreated?(tab: WorkbenchPanelTab): void | Promise<void>
  }) => {
    requests.push(input.requestId)
    const page = input.restore && pages.at(-1)
    if (page && resumeFailure) {
      resumeFailure = false
      if (input.selection) input.selection.pageId = page.id
      throw { type: "error", code: "browser_resume_failed", message: "Resume failed", retryable: true }
    }
    if (page) {
      page.status = "active"
      return { id: page.id, panelId: "browser", resourceId: page.id, state: { browserRoute } }
    }
    const id = `page-${++nativeOpens}`
    await new Promise<void>((resolve) => creates.push(resolve))
    pages.push({ id, title: id, url: "about:blank", status: "active", profileId: "personal" })
    const tab = { id, panelId: "browser", resourceId: id, state: { browserRoute } }
    await input.onCreated?.(tab)
    return tab
  },
  closeBrowserWorkbenchPage: (input: { pageId: string }) =>
    new Promise<void>((resolve) =>
      closes.push(() => {
        pages.splice(
          pages.findIndex((page) => page.id === input.pageId),
          1,
        )
        resolve()
      }),
    ),
}))

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
  pages.length = 0
  creates.length = 0
  closes.length = 0
  nativeOpens = 0
  resumeFailure = false
  requests.length = 0
})

describe("built-in workbench panels", () => {
  test("a confirmed resume failure retries the same page with a fresh command identity", async () => {
    const dispose = createRoot((done) => {
      BuiltinWorkbenchPanelsProvider({ children: null })
      return done
    })
    pages.push({ id: "saved", title: "Saved", url: "about:blank", status: "suspended", profileId: "personal" })
    resumeFailure = true
    const operation: WorkbenchPanelOpenContext = { requestId: "restore-one", onCancel() {} }
    try {
      const restore = listWorkbenchPanels().find((panel) => panel.id === "browser")!.restoreTab!
      await expect(Promise.resolve(restore(operation))).rejects.toMatchObject({ code: "browser_resume_failed" })
      expect(await restore(operation)).toMatchObject({ resourceId: "saved" })
      expect(requests).toHaveLength(2)
      expect(requests[1]).not.toBe(requests[0])
      expect(nativeOpens).toBe(0)
    } finally {
      dispose()
    }
  })

  test("reopening waits for a cancelled creation and its close acknowledgement before restoring", async () => {
    const dispose = createRoot((done) => {
      BuiltinWorkbenchPanelsProvider({ children: null })
      return done
    })
    const handlers = new Set<() => void | Promise<void>>()
    let cancelled = false
    const operation: WorkbenchPanelOpenContext = {
      requestId: "opening-one",
      onCancel(handler) {
        if (cancelled) return Promise.resolve().then(handler)
        handlers.add(handler)
      },
    }
    try {
      const entry = listWorkbenchPanels().find((panel) => panel.id === "browser")!
      const first = entry.createTab!(undefined, operation)
      for (let i = 0; i < 100 && nativeOpens < 1; i++) await Bun.sleep(1)
      expect(nativeOpens).toBe(1)
      cancelled = true
      await Promise.all([...handlers].map((handler) => handler()))
      const second = entry.restoreTab!({ requestId: "opening-two", onCancel() {} })
      await Bun.sleep(10)
      expect(nativeOpens).toBe(1)
      creates.shift()!()
      for (let i = 0; i < 100 && closes.length < 1; i++) await Bun.sleep(1)
      expect(closes).toHaveLength(1)
      expect(nativeOpens).toBe(1)
      closes.shift()!()
      await Promise.resolve(first).catch(() => undefined)
      for (let i = 0; i < 100 && nativeOpens < 2; i++) await Bun.sleep(1)
      creates.shift()!()
      expect(await second).toMatchObject({ resourceId: "page-2" })
      expect(pages.map((page) => page.id)).toEqual(["page-2"])
    } finally {
      dispose()
    }
  })

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
