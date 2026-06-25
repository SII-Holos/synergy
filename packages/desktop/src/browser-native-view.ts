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

export class BrowserNativeViewManager {
  private views = new Map<string, WebContentsView>()

  constructor(private window: BrowserWindow) {}

  async attach(input: BrowserNativeAttachRequest): Promise<void> {
    const view = this.views.get(input.tabId) ?? this.createView(input.tabId, input.sessionID)
    if (!this.views.has(input.tabId)) {
      this.views.set(input.tabId, view)
      this.window.contentView.addChildView(view)
    }

    if (input.bounds) this.resize(input.tabId, input.bounds)
    if (input.url && view.webContents.getURL() !== input.url) {
      await view.webContents.loadURL(input.url)
    }
  }

  detach(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    this.window.contentView.removeChildView(view)
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

  private createView(tabId: string, sessionID: string): WebContentsView {
    const partition = `persist:synergy-browser-${sessionID}-${tabId}`
    return new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
  }
}
