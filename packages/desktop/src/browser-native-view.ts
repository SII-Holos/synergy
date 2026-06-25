import { BrowserWindow, WebContentsView } from "electron"

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
  private controlConnections = new Map<string, BrowserNativeHostControlConnection>()
  private activeTabId: string | null = null

  constructor(private window: BrowserWindow) {}

  async attach(input: BrowserNativeAttachRequest): Promise<void> {
    const view = this.views.get(input.tabId) ?? this.createView(input.tabId, input.sessionID)
    if (!this.views.has(input.tabId)) {
      this.views.set(input.tabId, view)
    }
    this.ensureHostControl(input)

    this.activate(input.tabId, view)
    if (input.bounds) this.resize(input.tabId, input.bounds)
    if (input.url && view.webContents.getURL() !== input.url) {
      await view.webContents.loadURL(input.url)
    }
  }

  detach(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    if (this.activeTabId === tabId) {
      this.window.contentView.removeChildView(view)
      this.activeTabId = null
    }
    view.webContents.close()
    this.views.delete(tabId)
    this.controlConnections.get(tabId)?.close()
    this.controlConnections.delete(tabId)
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
    if (!input.serverUrl || this.controlConnections.has(input.tabId)) return
    const view = this.views.get(input.tabId)
    if (!view) return
    const connection = new BrowserNativeHostControlConnection(input, view, () => this.sessionState(input.sessionID))
    this.controlConnections.set(input.tabId, connection)
    connection.connect()
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

  private createView(tabId: string, sessionID: string): WebContentsView {
    const partition = `persist:synergy-browser-${sessionID}-${tabId}`
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const contents = view.webContents
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
    return view
  }

  private emit(event: BrowserNativeViewEvent): void {
    this.controlConnections.get(event.tabId)?.emitNativeEvent(event)
    if (this.window.isDestroyed()) return
    this.window.webContents.send("browser-native:event", event)
  }

  private sessionState(sessionID: string): BrowserNativeSessionState {
    const tabs = Array.from(this.views.entries()).map(([id, view]) => ({
      id,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      isLoading: view.webContents.isLoading(),
      pinned: false,
      kept: false,
      lastActiveAt: null,
    }))
    return { tabs, activeTabId: this.activeTabId }
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

class BrowserNativeHostControlConnection {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private consoleEntries: { level: string; text: string; timestamp: number; stackTrace?: string }[] = []
  private refMap = new Map<string, { backendNodeId: number; x: number; y: number; width: number; height: number }>()

  constructor(
    private input: BrowserNativeAttachRequest,
    private view: WebContentsView,
    private getSessionState: () => BrowserNativeSessionState,
  ) {}

  connect(): void {
    if (this.closed || !this.input.serverUrl) return
    const url = this.controlUrl()
    if (!url) return
    const ws = new WebSocket(url)
    this.ws = ws
    ws.addEventListener("open", () => {
      this.send({ type: "browser.host.ready", session: this.getSessionState() })
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
    if (event.type === "native.console") {
      this.consoleEntries.push({
        level: String(event.level),
        text: event.message,
        timestamp: Date.now(),
      })
      if (this.consoleEntries.length > 200) this.consoleEntries.splice(0, this.consoleEntries.length - 200)
    }

    switch (event.type) {
      case "native.loading":
        this.send({ type: "browser.host.event", event: { type: "page.loading", tabId: event.tabId, url: event.url } })
        break
      case "native.loaded":
        this.send({
          type: "browser.host.event",
          event: { type: "page.loaded", tabId: event.tabId, url: event.url, title: event.title },
        })
        this.send({ type: "browser.host.session", session: this.getSessionState() })
        break
      case "native.navigated":
        this.send({
          type: "browser.host.event",
          event: { type: "tab.updated", tab: this.tabState() },
        })
        this.send({ type: "browser.host.session", session: this.getSessionState() })
        break
      case "native.title":
        this.send({
          type: "browser.host.event",
          event: { type: "tab.updated", tab: this.tabState() },
        })
        this.send({ type: "browser.host.session", session: this.getSessionState() })
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
          code: error instanceof UnsupportedNativeCommandError ? "unsupported" : "failed",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private async execute(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const contents = this.view.webContents
    switch (command.type) {
      case "navigate": {
        const url = String(command.url ?? "about:blank")
        await contents.loadURL(url)
        return { type: "navigation", tab: this.tabState(), url: contents.getURL(), title: contents.getTitle() }
      }
      case "reload":
        contents.reload()
        return { type: "void" }
      case "stop":
        contents.stop()
        return { type: "void" }
      case "history":
        if (command.direction === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        if (command.direction === "forward" && contents.navigationHistory.canGoForward()) {
          contents.navigationHistory.goForward()
        }
        return { type: "void" }
      case "setViewport":
        return { type: "tab", tab: this.tabState() }
      case "click":
        this.dispatchMouse({ type: "input.mouse", action: "down", x: command.x, y: command.y, button: "left" })
        this.dispatchMouse({ type: "input.mouse", action: "up", x: command.x, y: command.y, button: "left" })
        return { type: "void" }
      case "typeText":
        await contents.insertText(String(command.text ?? ""))
        return { type: "void" }
      case "scroll":
        this.dispatchMouse({
          type: "input.mouse",
          action: "wheel",
          deltaX: command.deltaX,
          deltaY: command.deltaY,
        })
        return { type: "void" }
      case "mouse":
        this.dispatchMouse((command.input as Record<string, unknown>) ?? command)
        return { type: "void" }
      case "key":
        this.dispatchKey((command.input as Record<string, unknown>) ?? command)
        return { type: "void" }
      case "insertText":
        await contents.insertText(String(command.text ?? ""))
        return { type: "void" }
      case "evaluate":
        return {
          type: "evaluation",
          tabId: this.input.tabId,
          value: await contents.executeJavaScript(String(command.expression ?? ""), true),
        }
      case "snapshot": {
        const snapshot = await this.snapshot()
        return { type: "snapshot", tabId: this.input.tabId, elements: snapshot.elements, truncated: snapshot.truncated }
      }
      case "resolveRef": {
        const ref = String(command.ref ?? "")
        return { type: "resolvedRef", tabId: this.input.tabId, ref, box: this.refMap.get(ref) ?? null }
      }
      case "console":
        return { type: "console", tabId: this.input.tabId, entries: this.consoleEntries.slice(-50) }
      case "network":
        return { type: "network", tabId: this.input.tabId, requests: [] }
      case "assets":
        return { type: "assets", tabId: this.input.tabId, assets: [] }
      case "screenshot": {
        const image = await contents.capturePage()
        const size = image.getSize()
        return {
          type: "screenshot",
          tabId: this.input.tabId,
          dataUrl: image.toDataURL(),
          width: size.width,
          height: size.height,
        }
      }
      case "clearDiagnostics":
        this.consoleEntries = []
        return { type: "diagnostics.cleared", tabId: this.input.tabId }
      default:
        throw new UnsupportedNativeCommandError(String(command.type ?? "unknown"))
    }
  }

  private dispatchMouse(payload: Record<string, unknown>): void {
    const action = payload.action
    if (action === "wheel") {
      this.view.webContents.sendInputEvent({
        type: "mouseWheel",
        x: Number(payload.x ?? 0),
        y: Number(payload.y ?? 0),
        deltaX: Number(payload.deltaX ?? 0),
        deltaY: Number(payload.deltaY ?? 0),
      } as Electron.MouseWheelInputEvent)
      return
    }
    const type = action === "down" ? "mouseDown" : action === "up" ? "mouseUp" : action === "move" ? "mouseMove" : null
    if (!type) return
    this.view.webContents.sendInputEvent({
      type,
      x: Number(payload.x ?? 0),
      y: Number(payload.y ?? 0),
      button: this.mouseButton(payload.button),
      clickCount: Number(payload.clickCount ?? 1),
    } as Electron.MouseInputEvent)
  }

  private async snapshot(): Promise<{
    elements: { ref: string; role: string; name: string; value?: string; children: never[] }[]
    truncated: boolean
  }> {
    const result = (await this.view.webContents.executeJavaScript(
      `(() => {
        const selector = [
          "a[href]",
          "button",
          "input",
          "textarea",
          "select",
          "[role]",
          "[contenteditable='true']",
          "[tabindex]:not([tabindex='-1'])"
        ].join(",")
        const roleFor = (element) => {
          const explicit = element.getAttribute("role")
          if (explicit) return explicit
          const tag = element.tagName.toLowerCase()
          if (tag === "a") return "link"
          if (tag === "button") return "button"
          if (tag === "textarea") return "textbox"
          if (tag === "select") return "combobox"
          if (tag === "input") {
            const type = (element.getAttribute("type") || "text").toLowerCase()
            if (type === "checkbox") return "checkbox"
            if (type === "radio") return "radio"
            if (type === "search") return "searchbox"
            if (type === "range") return "slider"
            return "textbox"
          }
          return "generic"
        }
        const nameFor = (element) => {
          return element.getAttribute("aria-label")
            || element.getAttribute("title")
            || element.getAttribute("placeholder")
            || element.innerText
            || element.value
            || element.textContent
            || ""
        }
        const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 300)
        return nodes.map((element, index) => {
          const rect = element.getBoundingClientRect()
          return {
            ref: "@n" + (index + 1),
            role: roleFor(element),
            name: String(nameFor(element)).replace(/\\s+/g, " ").trim().slice(0, 200),
            value: "value" in element && typeof element.value === "string" ? element.value : undefined,
            box: {
              backendNodeId: index + 1,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          }
        }).filter((item) => item.box.width > 0 && item.box.height > 0 && item.name)
      })()`,
      true,
    )) as {
      ref: string
      role: string
      name: string
      value?: string
      box: { backendNodeId: number; x: number; y: number; width: number; height: number }
    }[]

    this.refMap.clear()
    const elements = result.map((item) => {
      this.refMap.set(item.ref, item.box)
      return {
        ref: item.ref,
        role: item.role,
        name: item.name,
        value: item.value,
        children: [],
      }
    })
    return { elements, truncated: result.length >= 300 }
  }

  private dispatchKey(payload: Record<string, unknown>): void {
    const action = payload.action
    const type = action === "down" ? "keyDown" : action === "up" ? "keyUp" : null
    if (!type) return
    this.view.webContents.sendInputEvent({
      type,
      keyCode: String(payload.key ?? payload.code ?? ""),
    } as Electron.KeyboardInputEvent)
  }

  private mouseButton(button: unknown): "left" | "middle" | "right" {
    if (button === "middle") return "middle"
    if (button === "right") return "right"
    return "left"
  }

  private tabState(): BrowserNativeTabState {
    return {
      id: this.input.tabId,
      url: this.view.webContents.getURL(),
      title: this.view.webContents.getTitle(),
      isLoading: this.view.webContents.isLoading(),
      pinned: false,
      kept: false,
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
}

class UnsupportedNativeCommandError extends Error {
  constructor(command: string) {
    super(command)
    this.name = "UnsupportedNativeCommandError"
  }
}
