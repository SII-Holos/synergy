import type { BrowserWindow, WebContentsView } from "electron"
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserNativeAttachRequest,
  type BrowserNativeBounds,
  type BrowserNativeViewEvent,
} from "@ericsanchezok/synergy-browser"
import { BrowserNativePagePool } from "./browser-native-page-pool.js"

export class BrowserNativeViewManager {
  private ownerKey: string | null = null
  private pageId: string | null = null
  private view: WebContentsView | null = null
  private eventCleanup: (() => void) | null = null

  constructor(
    private window: BrowserWindow,
    private pool: BrowserNativePagePool,
  ) {}

  async attach(input: BrowserNativeAttachRequest): Promise<void> {
    if (this.pageId && (this.ownerKey !== input.ownerKey || this.pageId !== input.pageId)) {
      this.detach(this.ownerKey!, this.pageId)
    }
    if (!this.view) {
      this.view = this.pool.attach(this.window, input.ownerKey, input.pageId)
      this.ownerKey = input.ownerKey
      this.pageId = input.pageId
      this.eventCleanup = this.bindEvents(input.pageId, this.view)
    }
    if (input.bounds) this.resize(input.ownerKey, input.pageId, input.bounds)
  }

  detach(ownerKey: string, pageId: string): void {
    if (this.ownerKey !== ownerKey || this.pageId !== pageId) return
    this.pool.detach(this.window, ownerKey, pageId)
    this.eventCleanup?.()
    this.eventCleanup = null
    this.view = null
    this.ownerKey = null
    this.pageId = null
  }

  focus(ownerKey: string, pageId: string): void {
    if (this.ownerKey === ownerKey && this.pageId === pageId) this.view?.webContents.focus()
  }

  resize(ownerKey: string, pageId: string, bounds: BrowserNativeBounds): void {
    if (this.ownerKey !== ownerKey || this.pageId !== pageId || !this.view) return
    this.view.setBounds({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    })
  }

  destroy(): void {
    if (this.ownerKey && this.pageId) this.detach(this.ownerKey, this.pageId)
  }

  private bindEvents(pageId: string, view: WebContentsView): () => void {
    const contents = view.webContents
    const emit = (event: BrowserNativeViewEvent) => {
      if (!this.window.isDestroyed()) this.window.webContents.send("browser-native:event", event)
    }
    const loading = () =>
      emit({
        type: "native.loading",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        pageId,
        url: boundedURL(contents.getURL()),
      })
    const loaded = () =>
      emit({
        type: "native.loaded",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        pageId,
        url: boundedURL(contents.getURL()),
        title: contents.getTitle().slice(0, 20_000),
      })
    const navigated = (_event: Electron.Event, url: string) =>
      emit({ type: "native.navigated", protocolVersion: BROWSER_PROTOCOL_VERSION, pageId, url: boundedURL(url) })
    const titled = (_event: Electron.Event, title: string) =>
      emit({ type: "native.title", protocolVersion: BROWSER_PROTOCOL_VERSION, pageId, title: title.slice(0, 20_000) })
    const failed = (_event: Electron.Event, code: number, message: string, url: string) =>
      emit({
        type: "native.error",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        pageId,
        code,
        message: message.slice(0, 100_000),
        url: boundedURL(url),
      })
    contents.on("did-start-loading", loading)
    contents.on("did-stop-loading", loaded)
    contents.on("did-navigate", navigated)
    contents.on("did-navigate-in-page", navigated)
    contents.on("page-title-updated", titled)
    contents.on("did-fail-load", failed)
    return () => {
      contents.off("did-start-loading", loading)
      contents.off("did-stop-loading", loaded)
      contents.off("did-navigate", navigated)
      contents.off("did-navigate-in-page", navigated)
      contents.off("page-title-updated", titled)
      contents.off("did-fail-load", failed)
    }
  }
}

function boundedURL(value: string): string {
  return value.slice(0, 20_000)
}
