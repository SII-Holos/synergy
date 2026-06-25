import { BrowserWindow, WebContentsView } from "electron"

export interface BrowserNativeBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserNativeAttachRequest {
  sessionID: string
  routeDirectory?: string
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
  private activeTabId: string | null = null

  constructor(private window: BrowserWindow) {}

  async attach(input: BrowserNativeAttachRequest): Promise<void> {
    const view = this.views.get(input.tabId) ?? this.createView(input.tabId, input.sessionID)
    if (!this.views.has(input.tabId)) {
      this.views.set(input.tabId, view)
    }

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
    if (this.window.isDestroyed()) return
    this.window.webContents.send("browser-native:event", event)
  }
}
