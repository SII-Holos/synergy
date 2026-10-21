import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { setupI18n } from "@lingui/core"
import type { useGlobalSDK as GlobalSDK } from "../../../src/context/global-sdk"
import type { useWorkbenchPanels as Workbench } from "../../../src/context/workbench"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"

export const endpoint = new URLSearchParams(location.search).get("backend")!
export const [session, setSession] = createSignal("session-a")
export const [active, setActive] = createSignal(true)
export const [mounted, setMounted] = createSignal(true)
export const [native, setNative] = createSignal(true)
export const workspace = { id: "wsp_fixture", generation: 2, scopeID: "scope", type: "local", path: "/fixture" }
export const [catalog, setCatalog] = createStore({
  session: {
    pages: [
      { id: "page", title: "Existing page", url: "https://example.test", status: "active", profileId: "personal" },
    ],
  },
})
export const route = {
  mode: "scope" as const,
  scopeID: "scope",
  path_directory: "scope",
  ownerKey: "scope-owner",
  serverUrl: endpoint,
}
export const reads: string[] = []
export const effects: string[] = []
export const events: string[] = []
let sdk: ReturnType<typeof GlobalSDK>
let workbench: ReturnType<typeof Workbench>
let pending: (() => void) | undefined
let hold = false
let capturedReply: ((payload: unknown) => boolean) | undefined
export function attachSDK(value: typeof sdk) {
  sdk = value
}
export function attachWorkbench(value: typeof workbench) {
  workbench = value
}
export const controls = {
  reads,
  effects,
  events,
  setSession,
  setActive,
  setMounted,
  setNative,
  hold() {
    hold = true
  },
  resolve() {
    pending?.()
    pending = undefined
  },
  tabs: () => workbench.surface("side").tabs(),
  reveal: () => workbench.surface("side").reveal(),
  select(id: string) {
    workbench.activateTab("side", id)
  },
  replaceFileWorkspace(id: string) {
    workbench.updateTab(id, {
      resourceId: "wsp_replacement@3/one.ts",
      state: { workspace: { ...workspace, id: "wsp_replacement", generation: 3 } },
    })
  },
  remove(id: string) {
    return workbench.closeTab(id)
  },
  sdk: () => sdk,
  captureReply() {
    sdk.clientMessages.subscribe((payload, reply) => {
      if (payload && typeof payload === "object" && "type" in payload && payload.type === "server.workbench.probe")
        capturedReply = reply
    })
  },
  hasReply: () => !!capturedReply,
  replyOld: () =>
    capturedReply?.({
      type: "client.workbench.receipt",
      properties: { requestId: "old-socket", outcome: { status: "applied" } },
    }),
  pages: (status: string) => setCatalog("session", "pages", 0, "status", status),
}
async function wait() {
  if (!hold) return
  hold = false
  await new Promise<void>((resolve) => {
    pending = resolve
  })
}
const bridge = {
  async presentationCapability() {
    return { protocolVersion: BROWSER_PROTOCOL_VERSION, managedLocal: true, status: "ready" }
  },
  async createPresentationTicket() {
    return { ok: true, ticket: "fixture" }
  },
}
export const usePlatform = () => ({
  platform: "desktop",
  get browserNative() {
    return native() ? bridge : undefined
  },
  openLink() {
    effects.push("external")
  },
  async fetch(request: Request) {
    const url = new URL(request.url)
    const pathname = url.pathname
    if (pathname === "/global/capabilities")
      return Response.json({
        apiVersion: 1,
        features: ["workbench", "note", "browser"],
        transports: { projection: "projection-v2" },
      })
    reads.push(pathname)
    if (pathname === "/note/meta") {
      await wait()
      return Response.json(
        url.searchParams.get("archived") === "true"
          ? []
          : [{ scopeID: "home", notes: [{ id: "note" }, { id: "other-note" }] }],
      )
    }
    if (pathname === "/workspace/files/stat") {
      await wait()
      return Response.json({ type: "file", path: url.searchParams.get("path"), mtime: 1, size: 12 })
    }
    if (pathname === "/workspace/files/read")
      return Response.json({
        node: { path: url.searchParams.get("path"), type: "file", mtime: 1, size: 15 },
        kind: "text",
        content: "Saved file body",
        contentVersion: "v1",
        range: { startLine: 1, endLine: 1 },
        truncated: false,
      })
    if (pathname === "/workspace/files/status") return Response.json({ files: [] })
    if (pathname.startsWith("/browser")) {
      effects.push(pathname)
      throw new Error("Viewing must not execute Browser commands")
    }
    throw new Error(`Unexpected fixture request: ${pathname}`)
  },
})
export const useServer = () => ({ url: endpoint, scopes: { prepare() {} } })
export const useSDK = () => ({
  url: endpoint,
  scopeKey: "scope",
  scopeID: "scope",
  directory: "/fixture",
  get client() {
    return sdk.client
  },
  get event() {
    return sdk.event
  },
})
export const useParams = () => ({
  dir: "scope",
  get id() {
    return session()
  },
})
export const useSync = () => ({
  data: { session: [], message: {}, part: {}, workspaces: [], path: { workspace } },
  session: { get: () => ({ workspace }) },
})
export const usePluginHost = () => ({ resources: { register: () => () => {} } })
export const useSessionTransition = () => ({ get: () => undefined })
export const draftTransitionKey = (server: string, scope: string) => JSON.stringify([server, scope])
export const useNoteDocuments = () => ({ peek: () => undefined })
export const useBrowserCatalog = () => ({
  get: async () => ({ route, store: catalog }),
  peek: () => ({ route, store: catalog }),
  refresh: async () => {},
})
export const i18n = setupI18n({ locale: "en", messages: { en: {} } })
export const useLocale = () => ({ i18n })
export const useConfirm = () => ({
  ask: async () => {
    effects.push("confirm")
    return false
  },
})
export const recordTokenReceive = () => {}
export const recordFrontendWork = () => {}
export const stopBrowserPerformanceMetrics = () => {}
const surfaces = new Map()
export const useLayout = () => ({
  isDesktop: () => true,
  sidebar: { occupiedWidth: () => 0, opened: () => false, width: () => 260 },
  transferWorkbenchState() {},
  surface(key: string, name: string) {
    const id = JSON.stringify([key, name])
    if (surfaces.has(id)) return surfaces.get(id)
    const [tabs, setTabs] = createSignal([]),
      [selected, setSelected] = createSignal<string>(),
      [opened, setOpened] = createSignal(false)
    const [size, setSize] = createSignal(600),
      [fullscreen, setFullscreen] = createSignal(false),
      [reveal, setReveal] = createSignal({})
    const value = {
      tabs,
      setTabs,
      active: selected,
      setActive: setSelected,
      opened,
      open: () => setOpened(true),
      close: () => setOpened(false),
      toggle: () => setOpened(!opened()),
      size,
      setSize,
      fullscreen,
      setFullscreen,
      reveal,
      setReveal,
    }
    surfaces.set(id, value)
    return value
  },
})
