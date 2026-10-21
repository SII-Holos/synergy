import type { BrowserWindow, WebContents, WebContentsView } from "electron"
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserNativeAttachRequest,
  type BrowserNativeBounds,
  type BrowserNativeViewEvent,
} from "@ericsanchezok/synergy-browser-core"
import type { BrowserNativePagePool } from "./browser-native-page-pool.js"
import { browserShortcut } from "./browser-page-actions.js"

export class BrowserNativeViewManager {
  private readonly contents: WebContents
  private visible = false
  private ownerKey: string | null = null
  private pageId: string | null = null
  private view: WebContentsView | null = null
  private eventCleanup: (() => void) | null = null
  private generationCleanup: (() => void) | null = null
  private documentReady = true

  constructor(
    private window: BrowserWindow,
    private pool: BrowserNativePagePool,
    private readonly sendEvent: (event: BrowserNativeViewEvent) => void,
  ) {
    this.contents = window.webContents
    this.contents.on("did-start-navigation", this.onNavigation)
    this.contents.on("render-process-gone", this.releaseDocument)
    this.contents.on("dom-ready", this.onDocumentReady)
  }

  private readonly onNavigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame && !event.isSameDocument) this.releaseDocument()
  }

  private readonly releaseDocument = () => {
    this.documentReady = false
    if (this.ownerKey && this.pageId) this.detach(this.ownerKey, this.pageId)
  }

  private readonly onDocumentReady = () => {
    this.documentReady = true
  }

  async attach(input: BrowserNativeAttachRequest): Promise<void> {
    if (!this.documentReady) throw new Error("The application document is not ready for browser presentation.")
    if (this.pageId && (this.ownerKey !== input.ownerKey || this.pageId !== input.pageId)) {
      this.detach(this.ownerKey!, this.pageId)
    }
    if (!this.view) {
      this.view = this.pool.attach(this.window, input.ownerKey, input.pageId)
      this.ownerKey = input.ownerKey
      this.pageId = input.pageId
      this.eventCleanup = this.bindEvents(input.pageId, this.view)
      this.generationCleanup = this.pool.onGeneration?.(input.ownerKey, input.pageId, (view, previous) => {
        if (this.view !== previous || this.ownerKey !== input.ownerKey || this.pageId !== input.pageId) return
        const bounds = previous.getBounds()
        const visible = previous.getVisible()
        const focused = previous.webContents.isFocused()
        this.eventCleanup?.()
        this.window.contentView.removeChildView(previous)
        view.setBounds(bounds)
        view.setVisible(visible)
        this.window.contentView.addChildView(view)
        this.view = view
        this.eventCleanup = this.bindEvents(input.pageId, view)
        if (focused) view.webContents.focus()
      })
    }
    const view = this.view
    const url = view.webContents.getURL()
    const cover =
      this.visible && input.visible === false ? view.webContents.capturePage().catch(() => undefined) : undefined
    this.visible = input.visible ?? true
    view.setVisible(this.visible)
    if (input.bounds) this.resize(input.ownerKey, input.pageId, input.bounds)
    const image = await cover
    if (!image || image.isEmpty() || this.visible || this.view !== view || view.webContents.getURL() !== url) return
    const bytes = image.toJPEG(75)
    if (bytes.length > 1_400_000) return
    this.sendEvent({
      type: "native.cover",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      pageId: input.pageId,
      url: boundedURL(url),
      dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
    })
  }

  detach(ownerKey: string, pageId: string): void {
    if (this.ownerKey !== ownerKey || this.pageId !== pageId) return
    this.pool.detach(this.window, ownerKey, pageId)
    this.eventCleanup?.()
    this.eventCleanup = null
    this.generationCleanup?.()
    this.generationCleanup = null
    this.visible = false
    this.view = null
    this.ownerKey = null
    this.pageId = null
  }

  focus(ownerKey: string, pageId: string): void {
    if (this.ownerKey === ownerKey && this.pageId === pageId) this.view?.webContents.focus()
  }

  resize(ownerKey: string, pageId: string, bounds: BrowserNativeBounds): void {
    if (this.ownerKey !== ownerKey || this.pageId !== pageId || !this.view) return
    const desktop = this.desktopBounds(bounds)
    this.view.setBounds({
      x: Math.max(0, desktop.x),
      y: Math.max(0, desktop.y),
      width: Math.max(1, desktop.width),
      height: Math.max(1, desktop.height),
    })
  }

  /** Renderer bounds are CSS pixels; convert them to desktop coordinates scaled by the host zoom. */
  private desktopBounds(bounds: BrowserNativeBounds): { x: number; y: number; width: number; height: number } {
    const zoom = Math.max(this.window.webContents.getZoomFactor(), 0.01)
    return {
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.round(bounds.width * zoom),
      height: Math.round(bounds.height * zoom),
    }
  }

  destroy(): void {
    this.releaseDocument()
    this.contents.off("did-start-navigation", this.onNavigation)
    this.contents.off("render-process-gone", this.releaseDocument)
    this.contents.off("dom-ready", this.onDocumentReady)
  }

  private bindEvents(pageId: string, view: WebContentsView): () => void {
    const contents = view.webContents
    const shortcut = (event: Electron.Event, input: Electron.Input) => {
      const action = browserShortcut(input, process.platform)
      if (!action) return
      event.preventDefault()
      this.window.webContents.focus()
      this.sendEvent({ type: "native.shortcut", protocolVersion: BROWSER_PROTOCOL_VERSION, pageId, action })
    }
    const updated = () => {
      if (!this.ownerKey) return
      const page = this.pool.find(this.ownerKey, pageId)?.state()
      if (page) this.sendEvent({ type: "native.page", protocolVersion: BROWSER_PROTOCOL_VERSION, pageId, page })
    }
    contents.on("did-start-loading", updated)
    contents.on("before-input-event", shortcut)
    contents.on("did-stop-loading", updated)
    contents.on("did-navigate", updated)
    contents.on("did-navigate-in-page", updated)
    contents.on("page-title-updated", updated)
    contents.on("did-fail-load", updated)
    return () => {
      contents.off("did-start-loading", updated)
      contents.off("before-input-event", shortcut)
      contents.off("did-stop-loading", updated)
      contents.off("did-navigate", updated)
      contents.off("did-navigate-in-page", updated)
      contents.off("page-title-updated", updated)
      contents.off("did-fail-load", updated)
    }
  }
}

function boundedURL(value: string): string {
  return value.slice(0, 20_000)
}
