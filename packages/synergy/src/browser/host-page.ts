import {
  BrowserProtocolError,
  isSafeBrowserObservation,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserHostPageEvent,
  type BrowserHostStatus,
  type BrowserPresentationKind,
} from "@ericsanchezok/synergy-browser"
import { BrowserBroker } from "./broker.js"
import type { BrowserOwner } from "./owner.js"
import type { BrowserPageBackend, BrowserPageEventHandlers } from "./page.js"

export class BrowserHostPage implements BrowserPageBackend {
  readonly id: string
  readonly backend = "host" as const
  url: string
  title = ""
  loading = false
  lastActiveAt: number | null = null
  private _hostStatus: BrowserHostStatus = "pending"
  private unsubscribe: () => void

  get hostStatus(): BrowserHostStatus {
    return this._hostStatus
  }

  private constructor(
    private owner: BrowserOwner.Info,
    id: string,
    url: string,
    private events: BrowserPageEventHandlers,
  ) {
    this.id = id
    this.url = url
    this.unsubscribe = BrowserBroker.subscribe(owner, id, (event) => this.handleEvent(event))
  }

  static async create(input: {
    owner: BrowserOwner.Info
    id: string
    url?: string
    presentation: BrowserPresentationKind
    routeDirectory: string
    events: BrowserPageEventHandlers
  }): Promise<BrowserHostPage> {
    const page = new BrowserHostPage(input.owner, input.id, input.url ?? "about:blank", input.events)
    try {
      const result = await BrowserBroker.createPage({
        owner: input.owner,
        routeDirectory: input.routeDirectory,
        presentation: input.presentation,
        pageId: input.id,
        url: input.url,
      })
      page.sync(result)
      page._hostStatus = "ready"
      return page
    } catch (error) {
      page.unsubscribe()
      throw error
    }
  }

  async execute(command: BrowserBackendCommand): Promise<BrowserBackendResult> {
    if (command.type !== "resume" && command.type !== "close" && !isSafeBrowserObservation(command)) {
      if (this._hostStatus === "restarting") throw hostStatusError(this.id, "restarting")
      if (this._hostStatus === "failed") throw hostStatusError(this.id, "failed")
    }
    const result = await BrowserBroker.command(this.owner, this.id, command)
    this.sync(result)
    return result
  }

  async close(): Promise<void> {
    if (!this.isAlive()) {
      this.unsubscribe()
      return
    }
    try {
      await BrowserBroker.closePage(this.owner, this.id)
    } finally {
      if (!this.isAlive()) this.unsubscribe()
    }
  }

  isAlive(): boolean {
    return BrowserBroker.hasPage(this.owner, this.id)
  }

  private sync(result: BrowserBackendResult): void {
    if (result.type !== "page" && result.type !== "navigation") return
    this.applyPage(result.page)
  }

  private applyPage(page: { url: string; title: string; isLoading: boolean; lastActiveAt: number | null }): void {
    this.url = page.url
    this.title = page.title
    this.loading = page.isLoading
    this.lastActiveAt = page.lastActiveAt
  }

  private handleEvent(event: BrowserHostPageEvent): void {
    if (event.type === "host.status") {
      this._hostStatus = event.status
      return
    }
    if (event.type === "page.loading") {
      this.loading = true
      this.url = event.url
      this.events.onLoading?.(this, event.url)
      return
    }
    if (event.type === "page.loaded") {
      this.applyPage(event.page)
      this.events.onLoaded?.(this)
      return
    }
    if (event.type === "page.updated") {
      this.applyPage(event.page)
      this.events.onUpdated?.(this)
      return
    }
    if (event.type === "page.error") {
      this.loading = false
      this.events.onError?.(this, event.message)
      return
    }
    if (event.type === "dialog.opened") {
      this.events.onDialog?.(this, {
        requestId: event.requestId,
        type: event.dialogType,
        message: event.message,
        defaultValue: event.defaultValue,
      })
      return
    }
    if (event.type === "filechooser.request") {
      this.events.onFileChooser?.(this, {
        requestId: event.requestId,
        multiple: event.multiple,
        accept: event.accept,
      })
      return
    }
    this.events.onDownload?.(this, event.entry)
  }
}

function hostStatusError(pageId: string, status: "restarting" | "failed"): BrowserProtocolError {
  const failed = status === "failed"
  const guidance = failed
    ? "Use browser_navigation with action resume or the native Browser Retry control to recover this page; use snapshot, read, or current to verify it before retrying a side effect."
    : "Wait for the Browser Host to report ready or use browser_navigation with action resume; do not retry a side effect while recovery is in progress."
  return new BrowserProtocolError({
    code: failed ? "browser_native_recovery_failed" : "browser_native_restarting",
    message: `The Browser Host is ${failed ? "in a failed recovery state" : "restarting"}. ${guidance}`,
    retryable: true,
    pageId,
    suggestedAction: guidance,
  })
}
