import { WebContentsView, type BrowserWindow } from "electron"
import {
  desktopStartupPage,
  startupStatusScript,
  startupThemeScript,
  startupWindowStateScript,
  type DesktopStartupStatus,
} from "./startup-page.js"
import type { DesktopThemeSnapshot } from "./theme.js"
import type { DesktopWindowState } from "./window-chrome.js"

export interface DesktopStartupOverlayOptions {
  window: BrowserWindow
  preloadPath: string
  chrome: "custom" | "native"
  iconDataUrl?: string
  theme: DesktopThemeSnapshot
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
  private statusScript: string | undefined

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
    this.statusScript = undefined
    await view.webContents.loadURL(
      desktopStartupPage({
        chrome: this.options.chrome,
        iconDataUrl: this.options.iconDataUrl,
        theme: this.options.theme,
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
    const script = startupStatusScript(status)
    if (script === this.statusScript) return
    this.statusScript = script
    await view.webContents.executeJavaScript(script).catch(() => {
      if (this.statusScript === script) this.statusScript = undefined
    })
  }

  setTheme(theme: DesktopThemeSnapshot): void {
    const view = this.view
    if (!view || this.dismissed || view.webContents.isDestroyed()) return
    view.webContents.executeJavaScript(startupThemeScript(theme)).catch(() => {})
  }

  setWindowState(state: DesktopWindowState): void {
    const view = this.view
    if (!view || this.dismissed || view.webContents.isDestroyed()) return
    view.webContents.executeJavaScript(startupWindowStateScript(state)).catch(() => {})
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
