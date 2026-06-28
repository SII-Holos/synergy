import { BrowserWindow, WebContentsView } from "electron"
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
  pageId: string
  url?: string
  bounds?: BrowserNativeBounds
}

export type BrowserNativeViewEvent =
  | { type: "native.loading"; pageId: string; url?: string }
  | { type: "native.loaded"; pageId: string; url?: string; title?: string }
  | { type: "native.navigated"; pageId: string; url: string }
  | { type: "native.title"; pageId: string; title: string }
  | { type: "native.console"; pageId: string; level: number; message: string; line?: number; sourceId?: string }
  | { type: "native.error"; pageId: string; code?: number; message: string; url?: string }

export class BrowserNativeViewManager {
  private view: WebContentsView | null = null
  private diagnostics: BrowserHostDiagnostics | null = null
  private controlConnection: BrowserNativeHostControlConnection | null = null
  private currentPageId: string | null = null
  private currentOwnerKey: string | null = null
  private lastBounds: BrowserNativeBounds | null = null

  constructor(private window: BrowserWindow) {}

  async attach(input: BrowserNativeAttachRequest): Promise<void> {
    const nextOwnerKey = ownerKey(input)
    if (this.currentPageId && (this.currentPageId !== input.pageId || this.currentOwnerKey !== nextOwnerKey)) {
      this.destroyView()
    }

    if (!this.view) {
      this.view = this.createView(input)
      this.currentPageId = input.pageId
      this.currentOwnerKey = nextOwnerKey
      this.window.contentView.addChildView(this.view)
    }

    this.ensureHostControl(input)
    if (input.bounds) {
      this.lastBounds = input.bounds
      this.resize(input.pageId, input.bounds)
    }
    if (input.url) {
      const url = normalizeBrowserURL(input.url)
      if (this.view.webContents.getURL() !== url) await this.view.webContents.loadURL(url)
    }
  }

  detach(pageId: string): void {
    if (this.currentPageId !== pageId) return
    this.destroyView()
    this.sendHostSession()
  }

  focus(pageId: string): void {
    if (this.currentPageId !== pageId) return
    this.view?.webContents.focus()
  }

  resize(pageId: string, bounds: BrowserNativeBounds): void {
    if (this.currentPageId !== pageId || !this.view) return
    this.view.setBounds({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    })
  }

  destroy(): void {
    this.destroyView()
    this.controlConnection?.close()
    this.controlConnection = null
  }

  private destroyView(): void {
    if (this.view) {
      this.window.contentView.removeChildView(this.view)
      this.view.webContents.close()
    }
    this.diagnostics?.dispose()
    this.diagnostics = null
    this.view = null
    this.currentPageId = null
  }

  private ensureHostControl(input: BrowserNativeAttachRequest): void {
    if (!input.serverUrl) return
    const key = ownerKey(input)
    if (this.controlConnection && this.controlConnection.key === key) return
    this.controlConnection?.close()
    this.controlConnection = new BrowserNativeHostControlConnection(input, {
      getSessionState: () => this.sessionState(),
      getPageId: () => this.currentPageId,
      getView: () => this.view ?? undefined,
      getDiagnostics: () => this.diagnostics ?? undefined,
    })
    this.controlConnection.connect()
  }

  private createView(input: BrowserNativeAttachRequest): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: browserProfilePartition(input),
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
      this.emit({ type: "native.loading", pageId: input.pageId, url: contents.getURL() })
    })
    contents.on("did-stop-loading", () => {
      this.emit({ type: "native.loaded", pageId: input.pageId, url: contents.getURL(), title: contents.getTitle() })
    })
    contents.on("did-navigate", (_event, url) => {
      this.emit({ type: "native.navigated", pageId: input.pageId, url })
    })
    contents.on("did-navigate-in-page", (_event, url) => {
      this.emit({ type: "native.navigated", pageId: input.pageId, url })
    })
    contents.on("page-title-updated", (_event, title) => {
      this.emit({ type: "native.title", pageId: input.pageId, title })
    })
    contents.on("console-message", (_event, level, message, line, sourceId) => {
      this.emit({ type: "native.console", pageId: input.pageId, level, message, line, sourceId })
    })
    contents.on("did-fail-load", (_event, code, message, url) => {
      this.emit({ type: "native.error", pageId: input.pageId, code, message, url })
    })
    this.diagnostics = new BrowserHostDiagnostics({
      pageId: input.pageId,
      contents,
      emitHostEvent: (event) => this.emitHostEvent(event),
    })
    this.diagnostics.start()
    return view
  }

  private emit(event: BrowserNativeViewEvent): void {
    this.controlConnection?.emitNativeEvent(event)
    if (this.window.isDestroyed()) return
    this.window.webContents.send("browser-native:event", event)
  }

  private emitHostEvent(event: Record<string, unknown>): void {
    this.controlConnection?.emitHostEvent(event)
  }

  private sessionState(): BrowserNativeSessionState {
    if (!this.currentPageId || !this.view) return { page: null }
    return { page: this.pageState(this.currentPageId, this.view) }
  }

  private pageState(pageId: string, view: WebContentsView): BrowserNativePageState {
    return {
      id: pageId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      isLoading: view.webContents.isLoading(),
      lastActiveAt: null,
    }
  }

  private sendHostSession(): void {
    this.controlConnection?.sendHostSession()
  }
}

interface BrowserNativePageState {
  id: string
  url: string
  title: string
  isLoading: boolean
  lastActiveAt: number | null
}

interface BrowserNativeSessionState {
  page: BrowserNativePageState | null
}

interface BrowserNativeHostCallbacks {
  getSessionState(): BrowserNativeSessionState
  getPageId(): string | null
  getView(): WebContentsView | undefined
  getDiagnostics(): BrowserHostDiagnostics | undefined
}

class BrowserNativeHostControlConnection {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private control: BrowserWebContentsControl | null = null
  readonly key: string

  constructor(
    private input: BrowserNativeAttachRequest,
    private host: BrowserNativeHostCallbacks,
  ) {
    this.key = ownerKey(input)
  }

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
    this.control = null
  }

  emitNativeEvent(event: BrowserNativeViewEvent): void {
    switch (event.type) {
      case "native.loading":
        this.send({ type: "browser.host.event", event: { type: "page.loading", pageId: event.pageId, url: event.url } })
        break
      case "native.loaded":
        this.send({
          type: "browser.host.event",
          event: { type: "page.loaded", pageId: event.pageId, url: event.url, title: event.title },
        })
        this.sendHostSession()
        break
      case "native.navigated":
      case "native.title":
        this.send({
          type: "browser.host.event",
          event: { type: "page.updated", page: this.host.getSessionState().page },
        })
        this.sendHostSession()
        break
      case "native.error":
        this.send({
          type: "browser.host.event",
          event: {
            type: "page.error",
            pageId: event.pageId,
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
    const pageId = typeof command.pageId === "string" ? command.pageId : this.host.getPageId()
    if (!pageId) throw new Error("No browser page is open")
    if (pageId !== this.host.getPageId()) throw new UnsupportedNativeCommandError(String(command.type ?? "unknown"))
    const view = this.host.getView()
    if (!view) throw new Error("Browser page not found")
    return this.controlFor(pageId, view).execute(command)
  }

  private controlFor(pageId: string, view: WebContentsView): BrowserWebContentsControl {
    if (this.control) return this.control
    this.control = new BrowserWebContentsControl({
      pageId,
      contents: () => view.webContents,
      diagnostics: () => this.host.getDiagnostics(),
      pageState: () => this.pageState(pageId, view),
    })
    return this.control
  }

  private pageState(pageId: string, view: WebContentsView): BrowserNativePageState {
    return {
      id: pageId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      isLoading: view.webContents.isLoading(),
      lastActiveAt: null,
    }
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
      pageId: this.input.pageId,
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
