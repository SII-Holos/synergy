import { BrowserOwner } from "./owner.js"
import { BrowserStorage } from "./storage.js"
import { BrowserProfiles } from "./profiles.js"
import { BrowserPolicy } from "./policy.js"
import { BrowserAnnotationHelper } from "./annotation.js"
import { BrowserDownloads } from "./downloads.js"
import { BrowserEvent } from "./event.js"
import {
  BrowserProtocolError,
  normalizeBrowserURL,
  redactBrowserText,
  type BrowserSessionPage,
  type BrowserHostDownloadEntry,
} from "@ericsanchezok/synergy-browser-core"
import type {
  BrowserPageBackend,
  BrowserPageEventHandlers,
  BrowserDialogRequest,
  BrowserFileChooserRequest,
} from "./page.js"
import type { BrowserAgentActivity, BrowserAnnotation, BrowserAnnotationInput, BrowserSession } from "./types.js"
export type { BrowserAnnotation, BrowserAnnotationInput, BrowserSession }

export interface BrowserPageFactoryInput {
  id: string
  url?: string
  profile: BrowserProfiles.Stored
  events: BrowserPageEventHandlers
  adopt?: boolean
}
interface PageEntry {
  state: BrowserSessionPage
  live?: BrowserPageBackend
  flight?: Promise<BrowserPageBackend>
  temporary?: boolean
}

export class BrowserSessionImpl implements BrowserSession {
  private entries = new Map<string, PageEntry>()
  private _annotations: BrowserAnnotation[] = []
  private saveTail: Promise<void> = Promise.resolve()
  private disposed = false
  private openings = new Map<string, { fingerprint: string; result: Promise<BrowserPageBackend> }>()
  private activity = new Map<string, string>()

  constructor(
    readonly owner: BrowserOwner.Info,
    private createPage: (input: BrowserPageFactoryInput) => Promise<BrowserPageBackend>,
  ) {}

  get pages(): BrowserSessionPage[] {
    return [...this.entries.keys()].map((id) => this.describe(id))
  }
  get annotations() {
    return this._annotations
  }
  get status(): BrowserSession["status"] {
    const pages = this.pages
    if (!pages.length) return "empty"
    if (pages.some((page) => page.status === "active")) return "active"
    return pages.some((page) => page.status === "failed") ? "failed" : "suspended"
  }

  describe(id: string): BrowserSessionPage {
    const entry = this.requireEntry(id)
    const page = entry.live
    return {
      ...entry.state,
      ...(page ? { url: page.url, title: page.title, isLoading: page.loading, lastActiveAt: page.lastActiveAt } : {}),
    }
  }

  getPage(id: string) {
    return this.entries.get(id)?.live
  }

  async openPage(input: { url?: string; profileId?: string; requestId?: string }): Promise<BrowserPageBackend> {
    if (!input.requestId) return this.openRequested(input)
    const fingerprint = JSON.stringify({ url: input.url ?? "about:blank", profileId: input.profileId })
    const existing = this.openings.get(input.requestId)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new BrowserProtocolError({
          code: "browser_command_id_conflict",
          message: "This open request was already used with different arguments.",
          retryable: false,
        })
      const page = await existing.result
      const entry = this.entries.get(page.id)
      if (!entry || !page.isAlive())
        throw new BrowserProtocolError({
          code: "browser_page_suspended",
          message: "The opened page has closed or suspended. List pages before continuing.",
          retryable: false,
          pageId: page.id,
        })
      await BrowserProfiles.requireEnabled(entry.state.profileId)
      return page
    }
    const result = this.openRequested(input)
    this.openings.set(input.requestId, { fingerprint, result })
    if (this.openings.size > 256) this.openings.delete(this.openings.keys().next().value!)
    return result
  }

  private async openRequested(input: { url?: string; profileId?: string }): Promise<BrowserPageBackend> {
    const profile = input.profileId
      ? await BrowserProfiles.requireEnabled(input.profileId)
      : await BrowserProfiles.defaultProfile()
    return this.create({ id: crypto.randomUUID(), url: input.url, profile })
  }

  async adoptPage(input: { id: string; url: string; openerId: string }): Promise<BrowserPageBackend> {
    const opener = this.requireEntry(input.openerId)
    const profile = await BrowserProfiles.requireEnabled(opener.state.profileId)
    return this.create({ ...input, profile, adopt: true })
  }

  private async create(input: {
    id: string
    url?: string
    profile: BrowserProfiles.Stored
    openerId?: string
    adopt?: boolean
  }): Promise<BrowserPageBackend> {
    if (this.disposed) throw new Error("Browser session is closed.")
    if (this.entries.has(input.id)) throw new Error("Browser page already exists.")
    this.checkCapacity()
    if (this.entries.size >= 64) throw new Error("Close a saved page before opening another (64-page limit).")
    const url = normalizeBrowserURL(input.url ?? "about:blank")
    this.checkNavigation(url)
    const entry: PageEntry = {
      temporary: input.profile.kind === "temporary",
      state: {
        id: input.id,
        url,
        title: "",
        isLoading: false,
        lastActiveAt: null,
        profileId: input.profile.id,
        status: "suspended",
        ...(input.openerId ? { openerId: input.openerId } : {}),
      },
    }
    this.entries.set(input.id, entry)
    try {
      return await this.start(entry, input.profile, input.adopt)
    } catch (error) {
      if (entry.live) await entry.live.close()
      this.entries.delete(input.id)
      await this.save()
      throw error
    }
  }

  private checkCapacity() {
    if ([...this.entries.values()].filter((entry) => entry.live || entry.flight).length >= 16)
      throw new BrowserProtocolError({
        code: "browser_page_limit",
        message: "Close a page before opening another (16 active pages per task).",
        retryable: false,
      })
  }

  private start(entry: PageEntry, profile: BrowserProfiles.Stored, adopt = false): Promise<BrowserPageBackend> {
    if (entry.flight) return entry.flight
    const flight = (async () => {
      const page = await this.createPage({
        id: entry.state.id,
        url: entry.state.url,
        profile,
        events: this.pageEvents(entry.state.id),
        adopt,
      })
      entry.live = page
      entry.state.status = "active"
      delete entry.state.error
      await this.save()
      BrowserEvent.publish(this.owner, { type: "page.created", page: this.describe(page.id) })
      return page
    })().finally(() => {
      entry.flight = undefined
    })
    entry.flight = flight
    return flight
  }

  async resumePage(id: string): Promise<BrowserPageBackend> {
    const entry = this.requireEntry(id)
    const profile = await BrowserProfiles.requireEnabled(entry.state.profileId)
    if (entry.flight) return entry.flight
    if (entry.live?.isAlive()) {
      await entry.live.execute({ type: "resume" })
      entry.state.status = "active"
      delete entry.state.error
      await this.save()
      return entry.live
    }
    if (entry.live) await entry.live.close()
    entry.live = undefined
    this.checkCapacity()
    this.checkNavigation(entry.state.url)
    return this.start(entry, profile)
  }

  async closePage(id: string): Promise<void> {
    const entry = this.requireEntry(id)
    await entry.flight?.catch(() => undefined)
    await entry.live?.close()
    this.entries.delete(id)
    this.activity.delete(id)
    await this.save()
    BrowserEvent.publish(this.owner, { type: "page.closed", pageId: id })
  }

  async suspendProfile(profileId: string): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.state.profileId !== profileId) continue
      await entry.flight?.catch(() => undefined)
      entry.state = this.describe(entry.state.id)
      await entry.live?.close()
      entry.live = undefined
      entry.state.status = "suspended"
      entry.state.isLoading = false
      BrowserEvent.publish(this.owner, { type: "page.updated", page: this.describe(entry.state.id) })
    }
    await this.save()
  }

  private requireEntry(id: string): PageEntry {
    const entry = this.entries.get(id)
    if (!entry)
      throw new BrowserProtocolError({
        code: "browser_page_missing",
        message: "Page not found. List pages and choose an available pageId.",
        retryable: false,
        pageId: id,
      })
    return entry
  }

  private checkNavigation(url: string) {
    const decision = BrowserPolicy.hardCheckNavigation(url, this.owner.directory)
    if (decision.decision !== "allow")
      throw new BrowserProtocolError({
        code: "browser_navigation_denied",
        message: decision.reason,
        retryable: false,
        url,
      })
  }

  private updatePage(page: BrowserPageBackend) {
    const entry = this.entries.get(page.id)
    if (!entry) return
    entry.state = {
      ...entry.state,
      url: page.url,
      title: page.title,
      isLoading: page.loading,
      lastActiveAt: page.lastActiveAt,
    }
    void this.save().catch((error) =>
      BrowserEvent.publish(this.owner, {
        type: "page.error",
        pageId: page.id,
        message: `Page state could not be saved: ${errorMessage(error)}`,
      }),
    )
  }

  private pageEvents(id: string): BrowserPageEventHandlers {
    return {
      onClosed: () => {
        if (!this.entries.delete(id)) return
        void this.save().catch(() => undefined)
        BrowserEvent.publish(this.owner, { type: "page.closed", pageId: id })
      },
      onStatus: (_page, status) => {
        const entry = this.entries.get(id)
        if (!entry) return
        entry.state.status = status === "ready" ? "active" : status === "failed" ? "failed" : "suspended"
        BrowserEvent.publish(this.owner, { type: "page.updated", page: this.describe(id) })
      },
      onLoading: (page) => {
        if (!this.entries.has(id)) return
        BrowserEvent.publish(this.owner, { type: "page.loading", pageId: page.id, url: page.url })
      },
      onLoaded: (page) => {
        if (!this.entries.has(id)) return
        this.updatePage(page)
        BrowserEvent.publish(this.owner, { type: "page.loaded", page: this.describe(page.id) })
      },
      onUpdated: (page) => {
        if (!this.entries.has(id)) return
        this.updatePage(page)
        BrowserEvent.publish(this.owner, { type: "page.updated", page: this.describe(page.id) })
      },
      onError: (page, message) => {
        const entry = this.entries.get(id)
        if (!entry) return
        entry.state.error = {
          type: "error",
          code: "browser_page_error",
          message: redactBrowserText(message),
          retryable: true,
          pageId: id,
        }
        void this.save()
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
            if (entry.state === "in_progress" || entry.state === "awaiting_approval") {
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
        this.updatePage(page)
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
    BrowserEvent.publish(this.owner, { type: "page.updated", page: this.describe(page.id) })
  }

  async notifyAgentActivity(activity: BrowserAgentActivity): Promise<void> {
    if (this.disposed) return
    if (activity.kind === "idle" && this.activity.get(activity.pageId) !== activity.operationID) return
    if (activity.kind === "idle") this.activity.delete(activity.pageId)
    else this.activity.set(activity.pageId, activity.operationID)
    BrowserEvent.publish(this.owner, { type: "agent.activity", ...activity })
  }

  async save(): Promise<void> {
    const operation = this.saveTail.then(() =>
      BrowserStorage.save(this.owner, {
        pages: this.pages.filter((page) => !this.entries.get(page.id)?.temporary),
        timestamp: Date.now(),
        annotations: this._annotations,
        downloads: BrowserDownloads.list(this.owner),
      }),
    )
    this.saveTail = operation.catch(() => undefined)
    return operation
  }

  async restore(): Promise<boolean> {
    const value = await BrowserStorage.load(this.owner)
    if (!value) return false
    for (const page of value.pages)
      this.entries.set(page.id, { state: { ...page, status: "suspended", isLoading: false } })
    this._annotations = value.annotations ?? []
    BrowserDownloads.restore(this.owner, value.downloads ?? [])
    return true
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.flight))
    const results = await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        entry.state = this.describe(entry.state.id)
        await entry.live?.close()
        entry.live = undefined
        entry.state.status = "suspended"
        entry.state.isLoading = false
      }),
    )
    await this.save()
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Some browser pages could not close.")
  }
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
