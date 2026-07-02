import { WebContentsView, type BrowserWindow } from "electron"
import { desktopStartupPage, startupStatusScript, type DesktopStartupStatus } from "./startup-page.js"

export interface DesktopStartupOverlayOptions {
  window: BrowserWindow
  preloadPath: string
  chrome: "custom" | "native"
  iconDataUrl?: string
}

const boundsEvents = ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "restore"] as const
type BoundsEvent = (typeof boundsEvents)[number]
type BoundsEventWindow = BrowserWindow & {
  on(event: BoundsEvent, listener: () => void): BrowserWindow
  off(event: BoundsEvent, listener: () => void): BrowserWindow
}

export class DesktopStartupOverlay {
  private view: WebContentsView | null = null
  private attached = false
  private dismissed = false

  constructor(private readonly options: DesktopStartupOverlayOptions) {
    this.view = new WebContentsView({
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  }

  async load(): Promise<void> {
    const view = this.view
    if (!view || this.dismissed) return
    await view.webContents.loadURL(
      desktopStartupPage({
        chrome: this.options.chrome,
        iconDataUrl: this.options.iconDataUrl,
      }),
    )
  }

  attach(): void {
    const view = this.view
    if (!view || this.dismissed || this.options.window.isDestroyed()) return
    if (!this.attached) {
      this.options.window.contentView.addChildView(view)
      const window = this.options.window as BoundsEventWindow
      for (const event of boundsEvents) window.on(event, this.syncBounds)
      this.attached = true
    }
    this.syncBounds()
  }

  async setStatus(status: DesktopStartupStatus): Promise<void> {
    const view = this.view
    if (!view || this.dismissed || view.webContents.isDestroyed()) return
    await view.webContents.executeJavaScript(startupStatusScript(status)).catch(() => {})
  }

  async dismiss(): Promise<void> {
    if (this.dismissed) return
    this.dismissed = true
    this.destroy()
  }

  destroy(): void {
    const view = this.view
    if (!view) return
    const window = this.options.window as BoundsEventWindow
    for (const event of boundsEvents) window.off(event, this.syncBounds)
    if (this.attached && !this.options.window.isDestroyed()) {
      this.options.window.contentView.removeChildView(view)
    }
    this.attached = false
    this.view = null
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private readonly syncBounds = () => {
    const view = this.view
    if (!view || this.options.window.isDestroyed()) return
    const bounds = this.options.window.getContentBounds()
    view.setBounds({
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    })
  }
}
