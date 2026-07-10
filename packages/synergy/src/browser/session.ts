import { BrowserOwner } from "./owner.js"
import { BrowserStorage } from "./storage.js"
import type { BrowserHostDownloadEntry } from "@ericsanchezok/synergy-browser"
import {
  PlaywrightBrowserPage,
  type BrowserDialogRequest,
  type BrowserFileChooserRequest,
  type BrowserPageBackend,
  type BrowserPageEventHandlers,
} from "./page.js"
import type { BrowserAgentActivity, BrowserAnnotation, BrowserAnnotationInput, BrowserSession } from "./types.js"
import { BrowserAnnotationHelper } from "./annotation.js"
import type { BrowserDriver } from "./driver.js"
import { BrowserDownloads } from "./downloads.js"
import {
  BrowserCheckpointSchema,
  BrowserProtocolError,
  redactBrowserText,
  type BrowserBackendCommand,
  type BrowserCheckpoint,
  type BrowserProtocolErrorData,
} from "@ericsanchezok/synergy-browser"
import { BrowserControl } from "./control.js"
import { BrowserEvent } from "./event.js"
import { BrowserPolicy } from "./policy.js"
export type { BrowserAnnotation, BrowserAnnotationInput, BrowserSession }

export class BrowserSessionImpl implements BrowserSession {
  readonly owner: BrowserOwner.Info
  private driver: BrowserDriver.Driver | null = null
  private driverProvider: () => Promise<BrowserDriver.Driver>
  private pageProvider: (input: {
    backend: BrowserPageBackend["backend"]
    owner: BrowserOwner.Info
    id?: string
    events: BrowserPageEventHandlers
  }) => Promise<BrowserPageBackend | null>
  private desiredBackend: () => BrowserPageBackend["backend"]
  private _page: BrowserPageBackend | null = null
  private _descriptor: BrowserSession["descriptor"] = null
  private _status: BrowserSession["status"] = "empty"
  private _annotations: BrowserAnnotation[] = []
  private _checkpoint: BrowserCheckpoint | null = null
  private _error: BrowserProtocolErrorData | null = null
  private saveTail: Promise<void> = Promise.resolve()
  get page(): BrowserPageBackend | null {
    return this._page
  }

  get annotations(): BrowserAnnotation[] {
    return this._annotations
  }

  get descriptor(): BrowserSession["descriptor"] {
    return this._page
      ? {
          id: this._page.id,
          url: this._page.url,
          title: this._page.title,
          lastActiveAt: this._page.lastActiveAt,
        }
      : this._descriptor
  }

  get status(): BrowserSession["status"] {
    if (this._status === "migrating") return "migrating"
    return this._page ? "active" : this._status
  }

  get checkpoint(): BrowserCheckpoint | null {
    return this._checkpoint
  }

  get error(): BrowserProtocolErrorData | null {
    return this._error
  }

  constructor(
    owner: BrowserOwner.Info,
    driverProvider: () => Promise<BrowserDriver.Driver>,
    pageProvider?: (input: {
      backend: BrowserPageBackend["backend"]
      owner: BrowserOwner.Info
      id?: string
      events: BrowserPageEventHandlers
    }) => Promise<BrowserPageBackend | null>,
    desiredBackend?: () => BrowserPageBackend["backend"],
  ) {
    this.owner = owner
    this.driverProvider = driverProvider
    this.pageProvider = pageProvider ?? (async () => null)
    this.desiredBackend = desiredBackend ?? (() => "headless")
  }

  private pageEvents(): BrowserPageEventHandlers {
    return {
      onLoading: (page) => {
        BrowserEvent.publish(this.owner, { type: "page.loading", pageId: page.id, url: page.url })
      },
      onLoaded: (page) => {
        this.queueEventSave(page)
        BrowserEvent.publish(this.owner, { type: "page.loaded", page: BrowserControl.pageState(page) })
      },
      onUpdated: (page) => {
        this.queueEventSave(page)
        BrowserEvent.publish(this.owner, { type: "page.updated", page: BrowserControl.pageState(page) })
      },
      onError: (page, message) => {
        BrowserEvent.publish(this.owner, {
          type: "page.error",
          pageId: page.id,
          url: page.url.slice(0, 20_000),
          message: redactBrowserText(message).slice(0, 100_000),
        })
      },
      onCrashed: (page, message) => {
        BrowserEvent.publish(this.owner, {
          type: "page.error",
          pageId: page.id,
          url: page.url.slice(0, 20_000),
          message: redactBrowserText(message).slice(0, 100_000),
        })
      },
      onDownload: (page, entry: BrowserHostDownloadEntry) => {
        const state = entry.state === "in_progress" ? "pending" : entry.state === "interrupted" ? "failed" : entry.state
        if (BrowserDownloads.get(this.owner, entry.id)) {
          BrowserDownloads.update(this.owner, entry.id, {
            state,
            path: entry.path,
            size: entry.totalBytes || undefined,
            mimeType: entry.mimeType,
          })
        } else {
          const tracked = BrowserDownloads.add(this.owner, {
            id: entry.id,
            pageID: page.id,
            url: entry.url,
            suggestedFilename: entry.fileName,
            mimeType: entry.mimeType,
            state,
            path: entry.path,
            size: entry.totalBytes || undefined,
            createdAt: entry.timestamp,
          })
          if (!tracked) {
            const limitedEntry = {
              ...entry,
              state: "blocked" as const,
              warning: "Download blocked because this Browser owner reached the 10,000-record limit.",
            }
            if (entry.state === "in_progress") {
              void page.execute({ type: "download.cancel", id: entry.id }).catch((error) => {
                BrowserEvent.publish(this.owner, {
                  type: "page.error",
                  pageId: page.id,
                  url: page.url,
                  message: `Browser download could not be cancelled after reaching the record limit: ${errorMessage(error)}`,
                })
              })
            }
            BrowserEvent.publish(this.owner, { type: "download.updated", pageId: page.id, entry: limitedEntry })
            return
          }
        }
        this.queueEventSave(page)
        const { path: _managedPath, ...publicEntry } = entry
        BrowserEvent.publish(this.owner, { type: "download.updated", pageId: page.id, entry: publicEntry })
      },
      onFileChooser: (page, request: BrowserFileChooserRequest) => {
        BrowserEvent.publish(this.owner, { type: "filechooser.request", pageId: page.id, ...request })
      },
      onDialog: (page, request: BrowserDialogRequest) => {
        BrowserEvent.publish(this.owner, {
          type: "dialog.opened",
          pageId: page.id,
          requestId: request.requestId,
          dialogType: request.type,
          message: request.message,
          defaultValue: request.defaultValue,
        })
      },
    }
  }

  async ensurePage(url?: string, options: { resume?: boolean } = {}): Promise<BrowserPageBackend> {
    const desired = this.desiredBackend()
    if (this._page) {
      if (!this._page.isAlive()) {
        this._descriptor = {
          id: this._page.id,
          url: this._page.url,
          title: this._page.title,
          lastActiveAt: this._page.lastActiveAt,
        }
        try {
          await this._page.close()
        } catch (error) {
          this._page = null
          const failure = new BrowserProtocolError({
            code: "browser_page_cleanup_failed",
            message: `The inactive Browser page could not release all resources: ${errorMessage(error)}`,
            retryable: true,
            pageId: this._descriptor.id,
            url: this._descriptor.url,
            suggestedAction: "Retry the command after the Browser backend finishes shutting down.",
          })
          await this.fail(failure)
          throw failure
        }
        this._page = null
        this._status = this._descriptor ? "suspended" : "failed"
      }
    }
    if (this._page) {
      if (this._page.backend !== desired) return this.migratePage(desired)
      return this._page
    }
    let browserPage: BrowserPageBackend
    try {
      browserPage = await this.createPage(desired, this._descriptor?.id)
    } catch (error) {
      await this.fail(error)
      throw error
    }
    this._page = browserPage
    this._status = "active"
    this._error = null

    const shouldRestore = options.resume !== false && !url && this._checkpoint
    const targetURL = url ?? (shouldRestore ? undefined : options.resume === false ? undefined : this.resumableURL())
    if (shouldRestore) {
      try {
        await browserPage.execute({ type: "checkpoint", action: "restore", checkpoint: this._checkpoint! })
      } catch (error) {
        await this.closeFailedPage(browserPage, error)
        await this.fail(error)
        throw error
      }
    } else if (targetURL) {
      try {
        const command: BrowserBackendCommand = { type: "navigate", url: targetURL, source: "user" }
        await browserPage.execute(command)
      } catch (error) {
        await this.closeFailedPage(browserPage, error)
        await this.fail(error)
        throw error
      }
    }

    await this.save()
    BrowserEvent.publish(this.owner, { type: "page.created", page: BrowserControl.pageState(browserPage) })
    return browserPage
  }

  async resumePage(): Promise<BrowserPageBackend> {
    return this.ensurePage()
  }

  async closePage(): Promise<void> {
    const page = this._page
    const pageID = page?.id ?? this._descriptor?.id
    let closeError: unknown
    try {
      await page?.close()
    } catch (error) {
      closeError = error
    }
    if (closeError && page?.isAlive()) {
      const failure = new BrowserProtocolError(
        {
          code: "browser_page_close_failed",
          message: `Browser page could not be closed: ${errorMessage(closeError)}`,
          retryable: true,
          pageId: page.id,
          url: page.url,
          suggestedAction: "Retry closing the Browser page.",
        },
        { cause: closeError instanceof Error ? closeError : undefined },
      )
      this._status = "active"
      this._error = failure.toJSON()
      await this.save()
      throw failure
    }
    this._page = null
    this._descriptor = null
    this._checkpoint = null
    this._error = null
    this._status = "empty"

    await this.save()
    if (pageID) BrowserEvent.publish(this.owner, { type: "page.closed", pageId: pageID })
    if (closeError) {
      throw new BrowserProtocolError(
        {
          code: "browser_page_cleanup_failed",
          message: `Browser page closed but some resources could not be released: ${errorMessage(closeError)}`,
          retryable: true,
          pageId: pageID,
        },
        { cause: closeError instanceof Error ? closeError : undefined },
      )
    }
  }

  getPage(pageID: string): BrowserPageBackend | undefined {
    return this._page?.id === pageID ? this._page : undefined
  }

  async addAnnotation(input: BrowserAnnotationInput): Promise<BrowserAnnotation> {
    if (this._annotations.length >= 10_000) {
      throw new BrowserProtocolError({
        code: "browser_annotation_limit_exceeded",
        message: "This Browser session already contains the maximum 10,000 annotations.",
        retryable: false,
        pageId: input.pageID,
        url: input.pageURL,
        suggestedAction: "Resolve or remove existing annotations before creating another one.",
      })
    }
    const annotation = BrowserAnnotationHelper.create(input)
    this._annotations.push(annotation)
    await this.save()
    return annotation
  }

  async removeAnnotation(id: string): Promise<boolean> {
    const idx = this._annotations.findIndex((a) => a.id === id)
    if (idx === -1) return false
    this._annotations.splice(idx, 1)
    await this.save()
    return true
  }

  async clearAnnotations(): Promise<void> {
    this._annotations = []
    await this.save()
  }

  formatAnnotationsForContext(): string {
    return BrowserAnnotationHelper.formatForContext(this._annotations)
  }

  async notifyPageNavigated(page: BrowserPageBackend): Promise<void> {
    BrowserEvent.publish(this.owner, { type: "page.updated", page: BrowserControl.pageState(page) })
  }

  async notifyAgentActivity(activity: BrowserAgentActivity): Promise<void> {
    BrowserEvent.publish(this.owner, { type: "agent.activity", ...activity })
  }

  async notifyControlChanged(mode: "user" | "agent"): Promise<void> {
    BrowserEvent.publish(this.owner, { type: "control.changed", mode })
  }

  async save(options: { captureCheckpoint?: boolean } = {}): Promise<void> {
    const operation = this.saveTail.then(async () => {
      if (options.captureCheckpoint && this._page && this._status !== "migrating") {
        await this.captureCheckpoint(this._page)
      }
      await this.persist()
    })
    this.saveTail = operation.catch(() => undefined)
    return operation
  }

  private async persist(): Promise<void> {
    if (this._page) {
      this._descriptor = {
        id: this._page.id,
        url: this._page.url,
        title: this._page.title,
        lastActiveAt: this._page.lastActiveAt,
      }
    }
    const state: BrowserStorage.SessionState = {
      status: this._page ? "active" : this._status === "failed" ? "failed" : this._descriptor ? "suspended" : "empty",
      page: this._descriptor,
      panelWidth: 400,
      timestamp: Date.now(),
      annotations: this._annotations,
      downloads: BrowserDownloads.list(this.owner),
      ...(this._checkpoint ? { checkpoint: this._checkpoint } : {}),
      ...(this._error ? { error: this._error } : {}),
    }
    if (this._page && this.driver) await this.driver.saveContextStorage(this.owner)
    await BrowserStorage.save(this.owner, state)
  }

  async restore(): Promise<boolean> {
    const data = await BrowserStorage.load(this.owner)
    if (!data) return false

    this._page = null
    this._descriptor = data.page
      ? {
          id: data.page.id,
          url: data.page.url,
          title: data.page.title,
          lastActiveAt: data.page.lastActiveAt ?? null,
        }
      : null
    this._status = data.status === "failed" ? "failed" : this._descriptor ? "suspended" : "empty"
    this._annotations = (data.annotations ?? []) as BrowserAnnotation[]
    BrowserDownloads.restore(this.owner, data.downloads ?? [])
    if (data.checkpoint) {
      const checkpoint = BrowserCheckpointSchema.parse(data.checkpoint)
      this._checkpoint =
        BrowserPolicy.hardCheckNavigation(checkpoint.url, this.owner.directory).decision === "allow" ? checkpoint : null
    } else {
      this._checkpoint = null
    }
    this._error = data.error ?? null
    return true
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = []
    let captureFailed = false
    let closeError: unknown
    const page = this._page
    if (page) {
      try {
        await this.captureCheckpoint(page)
      } catch (error) {
        captureFailed = true
        failures.push(error)
        this._checkpoint = null
      }
      this._descriptor = {
        id: page.id,
        url: page.url,
        title: page.title,
        lastActiveAt: page.lastActiveAt,
      }
      try {
        await page.close()
      } catch (error) {
        closeError = error
        failures.push(error)
      }
    }
    if (closeError && page?.isAlive()) {
      this._status = "active"
      this._error = failureData(closeError, {
        code: "browser_page_dispose_failed",
        message: "Browser page could not be closed during disposal.",
        retryable: true,
        pageId: page.id,
        url: page.url,
        suggestedAction: "Close the Browser page and retry shutdown.",
      })
      try {
        await this.save()
      } catch (error) {
        failures.push(error)
      }
      throw new AggregateError(failures, "Browser session disposal did not close its active page.")
    }
    this._page = null
    if (failures.length) {
      this._status = "failed"
      this._error = failureData(new AggregateError(failures, "Browser session disposal was incomplete."), {
        code: captureFailed ? "browser_checkpoint_capture_failed" : "browser_page_dispose_failed",
        message: "Browser session disposal was incomplete.",
        retryable: true,
        pageId: this._descriptor?.id,
        url: this._descriptor?.url,
        suggestedAction: "Resume the Browser page to recover its last known URL.",
      })
    } else {
      this._status = this._descriptor ? "suspended" : "empty"
      this._error = null
    }

    try {
      await this.save()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, "Browser session disposal did not complete cleanly.")
  }

  private async ensureDriver(): Promise<BrowserDriver.Driver> {
    this.driver ??= await this.driverProvider()
    return this.driver
  }

  private async createHeadlessPage(input: { owner: BrowserOwner.Info; id?: string }): Promise<BrowserPageBackend> {
    const driver = await this.ensureDriver()
    try {
      const page = await driver.newPage(input.owner)
      return new PlaywrightBrowserPage(page, input.owner, {
        id: input.id,
        events: this.pageEvents(),
        releaseOwner: () => driver.releaseOwner(input.owner),
      })
    } catch (error) {
      try {
        await driver.releaseOwner(input.owner)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Headless Browser page creation and cleanup both failed.")
      }
      throw error
    }
  }

  private async createPage(backend: BrowserPageBackend["backend"], id?: string): Promise<BrowserPageBackend> {
    const provided = await this.pageProvider({ backend, owner: this.owner, id, events: this.pageEvents() })
    if (provided) return provided
    if (backend === "headless") return this.createHeadlessPage({ owner: this.owner, id })
    throw new BrowserProtocolError({
      code: "browser_host_unavailable",
      message: "The Browser Host backend is not available.",
      retryable: true,
      pageId: id,
    })
  }

  private async migratePage(targetBackend: BrowserPageBackend["backend"]): Promise<BrowserPageBackend> {
    const source = this._page
    if (!source || source.backend === targetBackend) return source!
    const sourceBackend = source.backend
    const pageID = source.id
    this._status = "migrating"
    this._descriptor = {
      id: source.id,
      url: source.url,
      title: source.title,
      lastActiveAt: source.lastActiveAt,
    }

    let checkpoint: BrowserCheckpoint
    try {
      const captured = await source.execute({ type: "checkpoint", action: "capture" })
      if (captured.type !== "data") throw new Error("Browser backend returned an invalid checkpoint result.")
      checkpoint = BrowserCheckpointSchema.parse(captured.data)
      this._checkpoint = checkpoint
    } catch (error) {
      this._status = "active"
      throw new BrowserProtocolError({
        code: "browser_migration_capture_failed",
        message: `Could not capture the ${sourceBackend} browser page: ${errorMessage(error)}`,
        retryable: true,
        pageId: pageID,
        url: source.url,
      })
    }
    try {
      await source.close()
    } catch (error) {
      if (source.isAlive()) {
        this._status = "active"
        throw new BrowserProtocolError({
          code: "browser_migration_source_close_failed",
          message: `Could not close the ${sourceBackend} browser page before migration: ${errorMessage(error)}`,
          retryable: true,
          pageId: pageID,
          url: source.url,
        })
      }
    }
    this._page = null

    let target: BrowserPageBackend | null = null
    try {
      target = await this.createPage(targetBackend, pageID)
      await target.execute({ type: "checkpoint", action: "restore", checkpoint })
      this._page = target
      this._status = "active"
      this._error = null
      await this.save()
      BrowserEvent.publish(this.owner, { type: "page.updated", page: BrowserControl.pageState(target) })
      return target
    } catch (migrationError) {
      let targetCloseError: unknown
      if (target) {
        try {
          await target.close()
        } catch (error) {
          targetCloseError = error
        }
      }
      if (target?.isAlive()) {
        this._page = target
        this._status = "active"
        const failure = new BrowserProtocolError({
          code: "browser_migration_target_close_failed",
          message: `Target Browser page could not be closed after migration failed: ${errorMessage(targetCloseError)}`,
          retryable: true,
          pageId: pageID,
          url: checkpoint.url,
          suggestedAction: "Close the active Browser page before retrying migration.",
        })
        this._error = failure.toJSON()
        await this.save()
        throw failure
      }
      let restored: BrowserPageBackend | null = null
      try {
        restored = await this.createPage(sourceBackend, pageID)
        await restored.execute({ type: "checkpoint", action: "restore", checkpoint })
        this._page = restored
        this._status = "active"
        this._error = null
        await this.save()
      } catch (restoreError) {
        let restoredCloseError: unknown
        if (restored) {
          try {
            await restored.close()
          } catch (error) {
            restoredCloseError = error
          }
        }
        if (restored?.isAlive()) {
          this._page = restored
          this._status = "active"
          this._error = failureData(restoreError, {
            code: "browser_migration_restore_cleanup_failed",
            message: "Original Browser backend restore failed and its page could not be closed.",
            retryable: true,
            pageId: pageID,
            url: checkpoint.url,
            suggestedAction: "Close the active Browser page before retrying recovery.",
          })
          await this.save()
        } else if (restoredCloseError) {
          this._page = null
          await this.fail(
            new AggregateError(
              [restoreError, restoredCloseError],
              "Original Browser backend restore and resource cleanup both failed.",
            ),
          )
        } else {
          this._page = null
          await this.fail(restoreError)
        }
      }
      throw new BrowserProtocolError({
        code: "browser_migration_failed",
        message: `Could not migrate the browser page from ${sourceBackend} to ${targetBackend}: ${errorMessage(migrationError)}`,
        retryable: true,
        pageId: pageID,
        url: checkpoint.url,
        suggestedAction: this._page
          ? "Retry the command; the original backend was restored."
          : "Resume the page to retry recovery.",
      })
    }
  }

  private async fail(error: unknown): Promise<void> {
    this._status = "failed"
    this._error = failureData(error, {
      code: "browser_session_failed",
      message: "The Browser session failed.",
      retryable: true,
      pageId: this._descriptor?.id,
      url: this._descriptor?.url,
      suggestedAction: this._descriptor ? "Resume the Browser page to retry recovery." : "Retry the Browser command.",
    })
    await this.save()
  }

  private async closeFailedPage(page: BrowserPageBackend, cause: unknown): Promise<void> {
    let closeError: unknown
    try {
      await page.close()
    } catch (error) {
      closeError = error
    }
    if (closeError && page.isAlive()) {
      this._page = page
      this._status = "active"
      const failure = new BrowserProtocolError(
        {
          code: "browser_page_cleanup_failed",
          message: `Browser page initialization failed and cleanup could not close it: ${errorMessage(closeError)}`,
          retryable: true,
          pageId: page.id,
          url: page.url,
          suggestedAction: "Close the active Browser page before retrying.",
        },
        { cause: cause instanceof Error ? cause : undefined },
      )
      this._error = failure.toJSON()
      await this.save()
      throw failure
    }
    this._page = null
  }

  private queueEventSave(page: BrowserPageBackend): void {
    void this.save().catch((error) => {
      this._error = failureData(error, {
        code: "browser_state_persist_failed",
        message: "Browser state could not be persisted.",
        retryable: true,
        pageId: page.id,
        url: page.url,
        suggestedAction: "Retry the last Browser command after checking storage availability.",
      })
      BrowserEvent.publish(this.owner, {
        type: "page.error",
        pageId: page.id,
        url: page.url,
        message: this._error.message,
      })
    })
  }

  private async captureCheckpoint(page: BrowserPageBackend): Promise<void> {
    const result = await page.execute({ type: "checkpoint", action: "capture" })
    if (result.type !== "data") throw new Error("Browser backend returned an invalid checkpoint result.")
    this._checkpoint = BrowserCheckpointSchema.parse(result.data)
  }

  private resumableURL(): string | undefined {
    const url = this._descriptor?.url
    if (!url || url === "about:blank" || url.startsWith("[")) return undefined
    return url
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureData(error: unknown, fallback: Omit<BrowserProtocolErrorData, "type">): BrowserProtocolErrorData {
  return BrowserProtocolError.from(error, fallback).toJSON()
}
