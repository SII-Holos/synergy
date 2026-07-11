import { app, WebContentsView, type BrowserWindow } from "electron"
import type {
  BrowserBackendCommand,
  BrowserBackendResult,
  BrowserHostPageEvent,
  BrowserPage,
} from "@ericsanchezok/synergy-browser"
import { BrowserHostDiagnostics } from "./browser-host-diagnostics.js"
import { BrowserWebContentsControl } from "./browser-webcontents-control.js"
import { browserProfilePartition } from "./browser-profile.js"

export interface BrowserNativePageInput {
  ownerKey: string
  page: BrowserPage
  networkProxy: { server: string; username: string; password: string }
  downloadDir: string
  emit(event: BrowserHostPageEvent): void
}

export interface BrowserNativePageHandle {
  state(): BrowserPage
  execute(command: BrowserBackendCommand): Promise<BrowserBackendResult>
  destroy(): Promise<void>
}

interface Entry extends BrowserNativePageHandle {
  ownerKey: string
  view: WebContentsView
  control: BrowserWebContentsControl
  diagnostics: BrowserHostDiagnostics
  onLogin: (
    event: Electron.Event,
    webContents: Electron.WebContents,
    details: Electron.AuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ) => void
}

export class BrowserNativePagePool {
  private entries = new Map<string, Entry>()
  private creating = new Set<string>()

  async create(input: BrowserNativePageInput): Promise<BrowserNativePageHandle> {
    if (this.entries.has(input.ownerKey) || this.creating.has(input.ownerKey)) {
      throw new Error("Browser owner already has a native page.")
    }
    this.creating.add(input.ownerKey)
    let view: WebContentsView | undefined
    try {
      view = new WebContentsView({
        webPreferences: {
          partition: browserProfilePartition(input.ownerKey),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      const contents = view.webContents
      await contents.session.setProxy({ proxyRules: input.networkProxy.server })
    } catch (error) {
      this.creating.delete(input.ownerKey)
      if (view && !view.webContents.isDestroyed()) view.webContents.close()
      throw error
    }
    const contents = view.webContents
    const onLogin = (
      event: Electron.Event,
      webContents: Electron.WebContents,
      _details: Electron.AuthenticationResponseDetails,
      authInfo: Electron.AuthInfo,
      callback: (username?: string, password?: string) => void,
    ) => {
      if (!authInfo.isProxy || webContents !== contents) return
      event.preventDefault()
      callback(input.networkProxy.username, input.networkProxy.password)
    }
    app.on("login", onLogin)
    let diagnostics: BrowserHostDiagnostics | undefined
    let control: BrowserWebContentsControl | undefined
    try {
      await contents.loadURL("about:blank")
      diagnostics = new BrowserHostDiagnostics({
        pageId: input.page.id,
        contents,
        downloadDir: input.downloadDir,
        emitHostEvent: input.emit,
      })
      await diagnostics.start()
      const state = (): BrowserPage => ({
        id: input.page.id,
        url: (contents.getURL() || input.page.url).slice(0, 20_000),
        title: contents.getTitle().slice(0, 20_000),
        isLoading: contents.isLoading(),
        lastActiveAt: null,
      })
      const pageControl = new BrowserWebContentsControl({
        pageId: input.page.id,
        contents: () => contents,
        diagnostics: () => diagnostics,
        pageState: state,
        resize: (width, height) => view.setBounds({ x: 0, y: 0, width, height }),
        onNavigationBlocked: (url, reason) =>
          input.emit({ type: "page.error", pageId: input.page.id, url, message: reason }),
      })
      control = pageControl
      const entry: Entry = {
        ownerKey: input.ownerKey,
        view,
        control: pageControl,
        diagnostics,
        onLogin,
        state,
        async execute(command) {
          return pageControl.execute(command)
        },
        destroy: () => this.destroyEntry(input.ownerKey),
      }
      this.entries.set(input.ownerKey, entry)
      contents.on("did-start-loading", () =>
        input.emit({ type: "page.loading", pageId: input.page.id, url: contents.getURL().slice(0, 20_000) }),
      )
      contents.on("did-stop-loading", () => input.emit({ type: "page.loaded", page: state() }))
      contents.on("did-navigate", () => input.emit({ type: "page.updated", page: state() }))
      contents.on("did-navigate-in-page", () => input.emit({ type: "page.updated", page: state() }))
      contents.on("did-fail-load", (_event, _code, message, url) =>
        input.emit({
          type: "page.error",
          pageId: input.page.id,
          url: url.slice(0, 20_000),
          message: message.slice(0, 100_000),
        }),
      )
      if (input.page.url && input.page.url !== "about:blank") {
        await pageControl.execute({ type: "navigate", url: input.page.url, source: "user" })
      }
      return entry
    } catch (error) {
      this.entries.delete(input.ownerKey)
      app.off("login", onLogin)
      if (!contents.isDestroyed()) contents.close()
      const cleanup = await Promise.allSettled([control?.dispose(), diagnostics?.dispose()].filter(Boolean))
      const failures = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) {
        throw new AggregateError([error, ...failures], "Native Browser page creation and cleanup both failed.")
      }
      throw error
    } finally {
      this.creating.delete(input.ownerKey)
    }
  }

  find(ownerKey: string, pageId: string): Entry | undefined {
    const entry = this.entries.get(ownerKey)
    return entry?.state().id === pageId ? entry : undefined
  }

  attach(window: BrowserWindow, ownerKey: string, pageId: string): WebContentsView {
    const entry = this.find(ownerKey, pageId)
    if (!entry) throw new Error(`Native Browser Host page is not ready: ${pageId}`)
    window.contentView.addChildView(entry.view)
    return entry.view
  }

  detach(window: BrowserWindow, ownerKey: string, pageId: string): void {
    const entry = this.find(ownerKey, pageId)
    if (entry) window.contentView.removeChildView(entry.view)
  }

  async destroy(): Promise<void> {
    this.creating.clear()
    const results = await Promise.allSettled(Array.from(this.entries.keys(), (key) => this.destroyEntry(key)))
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "One or more native Browser pages could not be closed.")
  }

  private async destroyEntry(ownerKey: string): Promise<void> {
    const entry = this.entries.get(ownerKey)
    if (!entry) return
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false })
    if (!entry.view.webContents.isDestroyed()) throw new Error("Native Browser page did not close synchronously.")
    this.entries.delete(ownerKey)
    app.off("login", entry.onLogin)
    const results = await Promise.allSettled([entry.control.dispose(), entry.diagnostics.dispose()])
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Native Browser page resources were not fully released.")
  }
}
