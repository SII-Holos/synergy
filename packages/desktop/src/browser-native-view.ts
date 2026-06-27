import { BrowserWindow, WebContentsView } from "electron"
import { randomUUID } from "node:crypto"
import { normalizeBrowserURL } from "@ericsanchezok/synergy-util/browser-protocol"
import { BrowserHostDiagnostics } from "./browser-host-diagnostics.js"
import { BrowserWebContentsControl, UnsupportedBrowserWebContentsCommandError } from "./browser-webcontents-control.js"
import { browserProfilePartition } from "./browser-profile.js"

export interface BrowserNativeBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserNativeAttachRequest {
  serverUrl?: string
  sessionID: string
  routeDirectory?: string
  directory?: string
  scopeID?: string
  scopeKey?: string
  tabId: string
  url?: string
  bounds?: BrowserNativeBounds
}

export type BrowserNativeViewEvent =
  | { type: "native.loading"; tabId: string; url?: string }
  | { type: "native.loaded"; tabId: string; url?: string; title?: string }
  | { type: "native.navigated"; tabId: string; url: string }
  | { type: "native.title"; tabId: string; title: string }
  | { type: "native.console"; tabId: string; level: number; message: string; line?: number; sourceId?: string }
  | { type: "native.error"; tabId: string; code?: number; message: string; url?: string }

export class BrowserNativeViewManager {
  private views = new Map<string, WebContentsView>()
  private diagnostics = new Map<string, BrowserHostDiagnostics>()
  private controlConnections = new Map<string, BrowserNativeHostControlConnection>()
  private activeTabId: string | null = null
  private lastBounds: BrowserNativeBounds | null = null

  constructor(private window: BrowserWindow) {}

  async attach(input: BrowserNativeAttachRequest): Promise<void> {
    const view = this.views.get(input.tabId) ?? this.createView(input.tabId, input)
    if (!this.views.has(input.tabId)) {
      this.views.set(input.tabId, view)
    }
    this.ensureHostControl(input)

    this.activate(input.tabId, view)
    if (input.bounds) {
      this.lastBounds = input.bounds
      this.resize(input.tabId, input.bounds)
    }
    if (input.url) {
      const url = normalizeBrowserURL(input.url)
      if (view.webContents.getURL() !== url) await view.webContents.loadURL(url)
    }
  }

  detach(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    if (this.activeTabId === tabId) {
      this.window.contentView.removeChildView(view)
      this.activeTabId = null
    }
    this.diagnostics.get(tabId)?.dispose()
    this.diagnostics.delete(tabId)
    view.webContents.close()
    this.views.delete(tabId)
    this.sendHostSessions()
  }

  focus(tabId: string): void {
    this.views.get(tabId)?.webContents.focus()
  }

  resize(tabId: string, bounds: BrowserNativeBounds): void {
    const view = this.views.get(tabId)
    if (!view) return
    view.setBounds({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    })
  }

  destroy(): void {
    for (const tabId of this.views.keys()) {
      this.detach(tabId)
    }
    for (const connection of this.controlConnections.values()) connection.close()
    this.controlConnections.clear()
  }

  private ensureHostControl(input: BrowserNativeAttachRequest): void {
    const key = ownerKey(input)
    if (!input.serverUrl || this.controlConnections.has(key)) return
    const connection = new BrowserNativeHostControlConnection(input, {
      getSessionState: () => this.sessionState(),
      getActiveTabId: () => this.activeTabId,
      getView: (tabId?: string | null) => this.views.get(tabId || this.activeTabId || ""),
      getDiagnostics: (tabId?: string | null) => this.diagnostics.get(tabId || this.activeTabId || ""),
      createTab: (url?: string) => this.createManagedTab(input, url),
      closeTab: async (tabId: string) => {
        this.detach(tabId)
        return this.sessionState()
      },
      switchTab: (tabId: string) => {
        const view = this.views.get(tabId)
        if (!view) throw new Error(`Browser tab not found: ${tabId}`)
        this.activate(tabId, view)
        return this.tabState(tabId, view)
      },
    })
    this.controlConnections.set(key, connection)
    connection.connect()
  }

  private async createManagedTab(input: BrowserNativeAttachRequest, url?: string): Promise<BrowserNativeTabState> {
    const tabId = randomUUID()
    const view = this.createView(tabId, input)
    this.views.set(tabId, view)
    this.activate(tabId, view)
    if (this.lastBounds) this.resize(tabId, this.lastBounds)
    if (url) await view.webContents.loadURL(normalizeBrowserURL(url))
    const tab = this.tabState(tabId, view)
    for (const connection of this.controlConnections.values()) {
      connection.emitHostEvent({ type: "tab.created", tab, active: true })
      connection.sendHostSession()
    }
    return tab
  }

  private activate(tabId: string, view: WebContentsView): void {
    if (this.activeTabId === tabId) return
    if (this.activeTabId) {
      const active = this.views.get(this.activeTabId)
      if (active) this.window.contentView.removeChildView(active)
    }
    this.window.contentView.addChildView(view)
    this.activeTabId = tabId
  }

  private createView(tabId: string, input: BrowserNativeAttachRequest): WebContentsView {
    const partition = browserProfilePartition(input)
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const contents = view.webContents
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    contents.on("did-start-loading", () => {
      this.emit({ type: "native.loading", tabId, url: contents.getURL() })
    })
    contents.on("did-stop-loading", () => {
      this.emit({ type: "native.loaded", tabId, url: contents.getURL(), title: contents.getTitle() })
    })
    contents.on("did-navigate", (_event, url) => {
      this.emit({ type: "native.navigated", tabId, url })
    })
    contents.on("did-navigate-in-page", (_event, url) => {
      this.emit({ type: "native.navigated", tabId, url })
    })
    contents.on("page-title-updated", (_event, title) => {
      this.emit({ type: "native.title", tabId, title })
    })
    contents.on("console-message", (_event, level, message, line, sourceId) => {
      this.emit({ type: "native.console", tabId, level, message, line, sourceId })
    })
    contents.on("did-fail-load", (_event, code, message, url) => {
      this.emit({ type: "native.error", tabId, code, message, url })
    })
    const diagnostics = new BrowserHostDiagnostics({
      tabId,
      contents,
      emitHostEvent: (event) => this.emitHostEvent(event),
    })
    diagnostics.start()
    this.diagnostics.set(tabId, diagnostics)
    return view
  }

  private emit(event: BrowserNativeViewEvent): void {
    for (const connection of this.controlConnections.values()) connection.emitNativeEvent(event)
    if (this.window.isDestroyed()) return
    this.window.webContents.send("browser-native:event", event)
  }

  private emitHostEvent(event: Record<string, unknown>): void {
    for (const connection of this.controlConnections.values()) connection.emitHostEvent(event)
  }

  private sessionState(): BrowserNativeSessionState {
    const tabs = Array.from(this.views.entries()).map(([id, view]) => this.tabState(id, view))
    return { tabs, activeTabId: this.activeTabId }
  }

  private tabState(tabId: string, view: WebContentsView): BrowserNativeTabState {
    return {
      id: tabId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      isLoading: view.webContents.isLoading(),
      pinned: false,
      kept: false,
      lastActiveAt: null,
    }
  }

  private sendHostSessions(): void {
    for (const connection of this.controlConnections.values()) connection.sendHostSession()
  }
}

interface BrowserNativeTabState {
  id: string
  url: string
  title: string
  isLoading: boolean
  pinned: boolean
  kept: boolean
  lastActiveAt: number | null
}

interface BrowserNativeSessionState {
  tabs: BrowserNativeTabState[]
  activeTabId: string | null
}

interface BrowserNativeHostCallbacks {
  getSessionState(): BrowserNativeSessionState
  getActiveTabId(): string | null
  getView(tabId?: string | null): WebContentsView | undefined
  getDiagnostics(tabId?: string | null): BrowserHostDiagnostics | undefined
  createTab(url?: string): Promise<BrowserNativeTabState>
  closeTab(tabId: string): Promise<BrowserNativeSessionState>
  switchTab(tabId: string): BrowserNativeTabState
}

class BrowserNativeHostControlConnection {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private controls = new Map<string, BrowserWebContentsControl>()

  constructor(
    private input: BrowserNativeAttachRequest,
    private host: BrowserNativeHostCallbacks,
  ) {}

  connect(): void {
    if (this.closed || !this.input.serverUrl) return
    const url = this.controlUrl()
    if (!url) return
    const ws = new WebSocket(url)
    this.ws = ws
    ws.addEventListener("open", () => {
      this.sendHostSession("browser.host.ready")
    })
    ws.addEventListener("message", (event) => {
      this.handleMessage(event.data).catch((error) => {
        this.send({
          type: "browser.host.event",
          event: {
            type: "error",
            severity: "warning",
            code: "browser_native_host_command_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })
    })
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), 1000)
    })
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  emitNativeEvent(event: BrowserNativeViewEvent): void {
    switch (event.type) {
      case "native.loading":
        this.send({ type: "browser.host.event", event: { type: "page.loading", tabId: event.tabId, url: event.url } })
        break
      case "native.loaded":
        this.send({
          type: "browser.host.event",
          event: { type: "page.loaded", tabId: event.tabId, url: event.url, title: event.title },
        })
        this.sendHostSession()
        break
      case "native.navigated":
        this.send({
          type: "browser.host.event",
          event: { type: "tab.updated", tab: this.tabStateForEvent(event.tabId) },
        })
        this.sendHostSession()
        break
      case "native.title":
        this.send({
          type: "browser.host.event",
          event: { type: "tab.updated", tab: this.tabStateForEvent(event.tabId) },
        })
        this.sendHostSession()
        break
      case "native.error":
        this.send({
          type: "browser.host.event",
          event: {
            type: "page.error",
            tabId: event.tabId,
            url: event.url,
            message: event.message,
          },
        })
        break
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    const msg = JSON.parse(String(data)) as { id?: string; type?: string; command?: Record<string, unknown> }
    if (msg.type !== "browser.host.command" || !msg.id || !msg.command) return
    try {
      const result = await this.execute(msg.command)
      this.send({ type: "browser.host.result", id: msg.id, result })
    } catch (error) {
      this.send({
        type: "browser.host.result",
        id: msg.id,
        error: {
          code:
            error instanceof UnsupportedNativeCommandError || error instanceof UnsupportedBrowserWebContentsCommandError
              ? "unsupported"
              : "failed",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private async execute(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (command.type === "createTab") {
      const tab = await this.host.createTab(typeof command.url === "string" ? command.url : undefined)
      return { type: "tab", tab }
    }
    if (command.type === "closeTab") {
      const tabId = String(command.tabId ?? this.host.getActiveTabId() ?? "")
      const session = await this.host.closeTab(tabId)
      this.controls.delete(tabId)
      return { type: "session", session }
    }
    if (command.type === "switchTab") {
      const tab = this.host.switchTab(String(command.tabId ?? ""))
      this.sendHostSession()
      return { type: "tab", tab }
    }

    const tabId = typeof command.tabId === "string" ? command.tabId : this.host.getActiveTabId()
    const view = this.host.getView(tabId)
    if (!view) throw new Error(tabId ? `Browser tab not found: ${tabId}` : "No active browser tab")
    return this.controlFor(tabId!, view).execute(command)
  }

  private controlFor(tabId: string, view: WebContentsView): BrowserWebContentsControl {
    const existing = this.controls.get(tabId)
    if (existing) return existing
    const control = new BrowserWebContentsControl({
      tabId,
      contents: () => view.webContents,
      diagnostics: () => this.host.getDiagnostics(tabId),
      tabState: () => this.tabState(tabId, view),
    })
    this.controls.set(tabId, control)
    return control
  }

  private tabState(tabId: string, view: WebContentsView): BrowserNativeTabState {
    return {
      id: tabId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      isLoading: view.webContents.isLoading(),
      pinned: false,
      kept: false,
      lastActiveAt: null,
    }
  }

  private tabStateForEvent(tabId: string): BrowserNativeTabState | null {
    const view = this.host.getView(tabId)
    return view ? this.tabState(tabId, view) : null
  }

  private controlUrl(): string | null {
    const pathDirectory = this.input.routeDirectory ?? this.input.directory ?? this.input.scopeID ?? this.input.scopeKey
    if (!this.input.serverUrl || !pathDirectory) return null
    const params = new URLSearchParams({
      mode: "session",
      sessionID: this.input.sessionID,
      presentation: "native",
      client: "desktop",
      sameHost: "1",
    })
    if (this.input.scopeID) params.set("scopeID", this.input.scopeID)
    else if (this.input.directory) params.set("directory", this.input.directory)
    return (
      this.input.serverUrl.replace(/^http/, "ws") +
      `/${encodeURIComponent(pathDirectory)}/browser/host/control?${params.toString()}`
    )
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(payload))
  }

  emitHostEvent(event: Record<string, unknown>): void {
    this.send({ type: "browser.host.event", event })
  }

  sendHostSession(type: "browser.host.ready" | "browser.host.session" = "browser.host.session"): void {
    this.send({ type, session: this.host.getSessionState() })
  }
}

function ownerKey(input: BrowserNativeAttachRequest): string {
  return [input.sessionID, input.routeDirectory ?? input.directory ?? input.scopeID ?? input.scopeKey ?? ""].join(":")
}

class UnsupportedNativeCommandError extends Error {
  constructor(command: string) {
    super(command)
    this.name = "UnsupportedNativeCommandError"
  }
}
