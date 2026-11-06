import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"
import type { ResourceOpenController, ResourceOpenOptions } from "@ericsanchezok/synergy-ui/context/resource-open"

type Tab = { id: string; panelId: string; source?: string; resourceId?: string; state?: unknown }
type Listener = (payload: unknown, reply: (payload: unknown) => boolean) => void

const workspace = { id: "wsp_fixture", generation: 2, scopeID: "scope", type: "local", path: "/fixture" }
const route = { mode: "scope", scopeID: "scope", path_directory: "scope" }

function fixture() {
  const [session, setSession] = createSignal("session")
  const [active, setActive] = createSignal(true)
  const [connected, setConnected] = createSignal(true)
  const [generation, setGeneration] = createSignal(1)
  const [native, setNative] = createSignal(true)
  const listeners = new Set<Listener>()
  const frames: WorkbenchView.ClientMessage[] = []
  const notes = new Map<string, { base(): boolean; deleted(): boolean; error(): boolean }>()
  const files = new Map<
    string,
    { content?: string; loading?: boolean; stale?: boolean; deleted?: boolean; error?: string }
  >()
  const pages: { id: string; status: string; navigation?: { phase: string } }[] = []
  const unavailable = new Set<string>()
  const surface = (initial: Tab[]) => {
    const [tabs, setTabs] = createSignal(initial)
    const [selected, select] = createSignal(initial[0]?.id)
    const [opened, setOpened] = createSignal(true)
    const [revision, setRevision] = createSignal(0)
    const [fullscreen, setFullscreen] = createSignal(false)
    return {
      savedTabs: tabs,
      setTabs,
      active: selected,
      select,
      opened,
      setOpened,
      selectionRevision: revision,
      setRevision,
      fullscreen,
      setFullscreen,
      size: () => 600,
      close: mock((_origin: string) => setOpened(false)),
    }
  }
  const side = surface([
    { id: "note-view", panelId: "notes", source: "home", resourceId: "note" },
    { id: "file-view", panelId: "file", resourceId: "wsp_fixture@2/one.ts", state: { workspace } },
    { id: "page-view", panelId: "browser", resourceId: "page", state: { browserRoute: route } },
    { id: "asset-view", panelId: "attachment", resourceId: "asset://0123456789abcdef.txt" },
    { id: "unowned-file", panelId: "file", resourceId: "one.ts" },
    { id: "other-panel", panelId: "terminal" },
  ])
  const bottom = surface([])
  const sdk = {
    connected,
    connectionGeneration: generation,
    content: { current: () => ({ active: { scopeID: "scope", sessionID: session() } }) },
    clientMessages: {
      send: (frame: WorkbenchView.ClientMessage) => (frames.push(frame), true),
      subscribe(listener: Listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
  const workbench = {
    surface: (name: string) => (name === "side" ? side : bottom),
    getPanel: (name: string) => !unavailable.has(name),
    panelForTab: (tab: Tab) => !unavailable.has(tab.panelId),
  }
  const dialog = { active: false }
  const present = mock<NonNullable<ResourceOpenController["present"]>>(async () => ({ status: "cancelled" }))
  const resources: ResourceOpenController = { present, open: async () => ({ status: "cancelled" }) }
  let sequence = 0
  const request = (command: WorkbenchView.Command, requestId = `request-${++sequence}`) => {
    const frame: WorkbenchView.ServerMessage = {
      type: "server.workbench.request",
      properties: { requestId, scopeID: "scope", sessionID: session(), command },
    }
    return new Promise<WorkbenchView.Outcome>((resolve) => {
      for (const listener of listeners)
        listener(frame, (payload) => {
          const reply = WorkbenchView.ClientMessage.parse(payload)
          frames.push(reply)
          if (reply.type === "client.workbench.receipt") resolve(reply.properties.outcome)
          return true
        })
    })
  }
  return {
    sdk,
    workbench,
    resources,
    dialog,
    present,
    frames,
    listeners,
    request,
    notes,
    files,
    pages,
    unavailable,
    side,
    bottom,
    active,
    setActive,
    session,
    setSession,
    setConnected,
    setGeneration,
    native,
    setNative,
  }
}

let current: ReturnType<typeof fixture>
let dispose = () => {}
mock.module("../../src/context/global-sdk", () => ({ useGlobalSDK: () => current.sdk }))
mock.module("../../src/context/sdk", () => ({ useSDK: () => ({ url: "http://fixture.test", scopeID: "scope" }) }))
mock.module("../../src/context/session-route", () => ({
  useParams: () => ({
    get id() {
      return current.session()
    },
  }),
}))
mock.module("../../src/context/view-residency", () => ({ useViewActivity: () => current.active }))
mock.module("../../src/context/workbench", () => ({ useWorkbenchPanels: () => current.workbench }))
mock.module("../../src/context/layout", () => ({ useLayout: () => ({ sidebar: { occupiedWidth: () => 0 } }) }))
mock.module("../../src/context/platform", () => ({
  usePlatform: () => ({
    get browserNative() {
      return current.native()
    },
  }),
}))
mock.module("@ericsanchezok/synergy-ui/context/dialog", () => ({ useDialog: () => current.dialog }))
mock.module("../../src/context/file", () => ({
  useProjectFiles: () => ({ peek: (_workspace: unknown, path: string) => current.files.get(path) }),
}))
mock.module("../../src/components/note/documents", () => ({
  useNoteDocuments: () => ({ peek: (_source: string, id: string) => current.notes.get(id) }),
}))
mock.module("../../src/components/workspace/browser/browser-catalog", () => ({
  useBrowserCatalog: () => ({ peek: () => ({ store: { session: { pages: current.pages } } }) }),
}))

const { createWorkbenchViewExecutor } = await import("../../src/context/workbench-view")
function mount() {
  createRoot((cleanup) => {
    dispose = cleanup
    createWorkbenchViewExecutor(current.resources)
  })
}
beforeEach(() => {
  current = fixture()
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 })
})
afterEach(() => {
  dispose()
  document.body.replaceChildren()
})

test("executor snapshots distinguish selected presentation from each reader's content readiness", async () => {
  mount()
  expect(current.frames).toContainEqual({
    type: "client.workbench.ready",
    properties: { version: WorkbenchView.VERSION, targets: ["note", "workspace-file", "browser-page", "asset"] },
  })
  let views = (await current.request({ action: "status" })).views!
  expect(views).toHaveLength(4)
  expect(views.find((view) => view.viewId === "note-view")).toMatchObject({ visible: true, contentState: "loading" })
  expect(views.find((view) => view.viewId === "page-view")?.contentState).toBe("unavailable")
  current.notes.set("note", { base: () => true, deleted: () => false, error: () => false })
  current.files.set("one.ts", { content: "Saved body" })
  current.pages.push({ id: "page", status: "active", navigation: { phase: "completed" } })
  views = (await current.request({ action: "status" })).views!
  expect(views.filter((view) => view.contentState === "ready").map((view) => view.target.kind)).toEqual([
    "note",
    "workspace-file",
    "browser-page",
  ])
  current.notes.set("note", { base: () => true, deleted: () => true, error: () => false })
  current.files.set("one.ts", { error: "Read failed" })
  current.pages[0].navigation = { phase: "failed" }
  current.setNative(false)
  views = (await current.request({ action: "status" })).views!
  expect(views.filter((view) => view.contentState === "unavailable")).toHaveLength(3)
  expect(views.find((view) => view.viewId === "asset-view")).toMatchObject({ visible: false, contentState: "loading" })
  dispose()
  expect(current.listeners.size).toBe(0)
  expect(current.frames.at(-1)).toEqual({
    type: "client.workbench.ready",
    properties: { version: WorkbenchView.VERSION, targets: [] },
  })
})

test("executor requires a selected committed view, retains failure details and deduplicates presentation", async () => {
  mount()
  current.present.mockImplementation(async () => ({ status: "opened", view: { viewId: "note-view", surface: "side" } }))
  const command: WorkbenchView.Command = { action: "open", target: { kind: "note", id: "note" } }
  expect((await current.request(command, "same")).status).toBe("applied")
  expect((await current.request(command, "same")).status).toBe("applied")
  expect(current.present).toHaveBeenCalledTimes(1)
  expect((await current.request({ action: "status", requestId: "same" })).status).toBe("applied")
  expect((await current.request({ action: "status", requestId: "missing" })).status).toBe("unknown")
  expect((await current.request({ action: "hide", viewId: "note-view" }, "same")).status).toBe("blocked")
  current.present.mockImplementation(async () => ({ status: "opened", view: { viewId: "file-view", surface: "side" } }))
  expect((await current.request(command)).status).toBe("unknown")
  current.present.mockImplementation(async () => ({ status: "unavailable", reason: "Reader not installed" }))
  expect(await current.request(command)).toMatchObject({ status: "unavailable", reason: "Reader not installed" })
  current.present.mockImplementation(async () => {
    throw new Error("Resource lookup failed")
  })
  expect(await current.request(command)).toEqual({ status: "unavailable", reason: "Resource lookup failed" })
})

test("executor hides only its known resource identity and does not close a replacement tab", async () => {
  mount()
  expect((await current.request({ action: "hide", viewId: "note-view" })).status).toBe("unavailable")
  await current.request({ action: "status" })
  current.side.setTabs((tabs) =>
    tabs.map((tab) => (tab.id === "note-view" ? { ...tab, resourceId: "replacement" } : tab)),
  )
  expect((await current.request({ action: "hide", viewId: "note-view" })).status).toBe("superseded")
  expect(current.side.opened()).toBe(true)
  expect((await current.request({ action: "hide", viewId: "note-view" })).status).toBe("applied")
  expect(current.side.opened()).toBe(false)
  expect(current.side.close).toHaveBeenCalledWith("agent")
  expect(current.side.savedTabs()).toHaveLength(6)
})

test("executor protects modal and focused resources and fences a delayed commit after human selection", async () => {
  mount()
  const command: WorkbenchView.Command = { action: "open", target: { kind: "note", id: "note" } }
  current.dialog.active = true
  expect((await current.request(command)).status).toBe("blocked")
  current.dialog.active = false
  const panel = document.createElement("div")
  panel.dataset.uiPart = "resource-panel"
  const input = document.createElement("input")
  panel.append(input)
  document.body.append(panel)
  input.focus()
  expect((await current.request(command)).status).toBe("blocked")
  input.blur()
  let finish!: () => void
  let options: ResourceOpenOptions | undefined
  current.present.mockImplementation((_target, captured) => {
    options = captured
    return new Promise((resolve) => {
      finish = () => resolve({ status: "cancelled" })
    })
  })
  const pending = current.request(command)
  expect(options?.canCommit?.()).toBe(true)
  current.side.setRevision(1)
  expect(options?.canCommit?.()).toBe(false)
  finish()
  expect((await pending).status).toBe("superseded")
  expect(current.side.active()).toBe("note-view")
})

test("executor cancels pending work on ownership and connection changes without stale completion", async () => {
  mount()
  const command: WorkbenchView.Command = { action: "open", target: { kind: "note", id: "note" } }
  const completions: (() => void)[] = []
  const signals: AbortSignal[] = []
  current.present.mockImplementation((_target, options) => {
    signals.push(options!.signal!)
    return new Promise((resolve) => {
      completions.push(() => resolve({ status: "cancelled" }))
    })
  })
  const inactive = current.request(command)
  current.setActive(false)
  expect((await inactive).status).toBe("superseded")
  expect(signals[0].aborted).toBe(true)
  current.setActive(true)
  const disconnected = current.request(command)
  current.setConnected(false)
  expect(["superseded", "cancelled"]).toContain((await disconnected).status)
  expect(signals[1].aborted).toBe(true)
  current.setConnected(true)
  current.setGeneration(2)
  const cancelled = current.request(command, "cancel-this")
  for (const listener of current.listeners)
    listener({ type: "server.workbench.cancel", properties: { requestId: "cancel-this" } }, () => true)
  expect((await cancelled).status).toBe("cancelled")
  for (const finish of completions) finish()
  await Promise.resolve()
  expect(current.present).toHaveBeenCalledTimes(3)
})
