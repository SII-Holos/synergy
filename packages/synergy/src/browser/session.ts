import { BrowserOwner } from "./owner.js"
import { BrowserStorage } from "./storage.js"
import {
  BrowserTabImpl,
  type BrowserDialogRequest,
  type BrowserDownloadEntry,
  type BrowserFileChooserRequest,
  type BrowserTab,
  type BrowserTabEventHandlers,
} from "./tab.js"
import type {
  BrowserAgentActivity,
  BrowserAnnotation,
  BrowserAnnotationInput,
  BrowserPage,
  BrowserSession,
  BrowserSessionObserver,
} from "./types.js"
import { BrowserAnnotationHelper } from "./annotation.js"
import type { BrowserDriver } from "./driver.js"
export type { BrowserAnnotation, BrowserAnnotationInput, BrowserSession }

export class BrowserSessionImpl implements BrowserSession {
  readonly owner: BrowserOwner.Info
  private driver: BrowserDriver.Driver
  private _page: BrowserTabImpl | null = null
  private _annotations: BrowserAnnotation[] = []
  private _observers = new Set<BrowserSessionObserver>()

  get page(): BrowserPage | null {
    return this._page
  }

  get annotations(): BrowserAnnotation[] {
    return this._annotations
  }

  constructor(owner: BrowserOwner.Info, driver: BrowserDriver.Driver) {
    this.owner = owner
    this.driver = driver
  }

  private tabEvents(): BrowserTabEventHandlers {
    return {
      onLoading: (tab) => {
        for (const o of this._observers) o.onPageLoadState?.(tab, "loading")
        for (const o of this._observers) o.onPageUpdated?.(tab)
      },
      onLoaded: (tab) => {
        this.save().catch(() => {})
        for (const o of this._observers) o.onPageLoadState?.(tab, "loaded")
        for (const o of this._observers) o.onPageNavigated?.(tab)
        for (const o of this._observers) o.onPageUpdated?.(tab)
      },
      onError: (tab, message) => {
        for (const o of this._observers) o.onPageLoadState?.(tab, "error", message)
      },
      onCrashed: (tab, message) => {
        for (const o of this._observers) o.onPageLoadState?.(tab, "error", message)
      },
      onDownload: (tab, entry: BrowserDownloadEntry) => {
        for (const o of this._observers) o.onDownload?.(tab, entry)
      },
      onFileChooser: (tab, request: BrowserFileChooserRequest) => {
        for (const o of this._observers) o.onFileChooser?.(tab, request)
      },
      onDialog: (tab, request: BrowserDialogRequest) => {
        for (const o of this._observers) o.onDialog?.(tab, request)
      },
    }
  }

  async ensurePage(url?: string): Promise<BrowserPage> {
    if (this._page) return this._page
    const page = await this.driver.newPage(this.owner, url)
    const browserPage = new BrowserTabImpl({
      page,
      directory: this.owner.directory,
      owner: this.owner,
      events: this.tabEvents(),
    })
    this._page = browserPage

    if (url) {
      try {
        await browserPage.navigate(url)
      } catch {
        /* navigation may fail; page still exists */
      }
    }

    await this.save()
    for (const o of this._observers) o.onPageCreated?.(browserPage)
    return browserPage
  }

  async closePage(): Promise<void> {
    if (!this._page) return
    const pageID = this._page.id
    await this._page.close()
    this._page = null

    await this.save()
    for (const o of this._observers) o.onPageClosed?.(pageID)
  }

  getPage(pageID: string): BrowserPage | undefined {
    return this._page?.id === pageID ? this._page : undefined
  }

  addAnnotation(input: BrowserAnnotationInput): BrowserAnnotation {
    const annotation = BrowserAnnotationHelper.create(input)
    this._annotations.push(annotation)
    this.save()
    return annotation
  }

  removeAnnotation(id: string): boolean {
    const idx = this._annotations.findIndex((a) => a.id === id)
    if (idx === -1) return false
    this._annotations.splice(idx, 1)
    this.save()
    return true
  }

  clearAnnotations(): void {
    this._annotations = []
    this.save()
  }

  formatAnnotationsForContext(): string {
    return BrowserAnnotationHelper.formatForContext(this._annotations)
  }

  addObserver(observer: BrowserSessionObserver): () => void {
    this._observers.add(observer)
    return () => {
      this._observers.delete(observer)
    }
  }

  async notifyPageNavigated(page: BrowserPage): Promise<void> {
    for (const o of this._observers) o.onPageNavigated?.(page)
  }

  async notifyAgentActivity(activity: BrowserAgentActivity): Promise<void> {
    for (const o of this._observers) o.onAgentActivity?.(activity)
  }

  async notifyControlChanged(mode: "user" | "agent"): Promise<void> {
    for (const o of this._observers) o.onControlChanged?.(mode)
  }

  async save(): Promise<void> {
    const state: BrowserStorage.SessionState = {
      page: this._page
        ? {
            id: this._page.id,
            url: this._page.url,
            title: this._page.title,
            lastActiveAt: this._page.lastActiveAt,
          }
        : null,
      panelWidth: 400,
      timestamp: Date.now(),
      annotations: this._annotations,
      storageStatePath: BrowserStorage.storageStatePath(this.owner),
      profileDir: BrowserStorage.profileDir(this.owner),
    }
    await this.driver.saveContextStorage(this.owner)
    await BrowserStorage.save(this.owner, state)
  }

  async restore(): Promise<boolean> {
    const data = await BrowserStorage.load(this.owner)
    if (!data) return false

    if (this._page) {
      try {
        await this._page.close()
      } catch {
        /* ignore */
      }
    }
    this._page = null

    const saved = data.page
    if (saved) {
      const page = await this.driver.newPage(this.owner)
      const browserPage = new BrowserTabImpl({
        page,
        directory: this.owner.directory,
        owner: this.owner,
        id: saved.id,
        events: this.tabEvents(),
      })
      browserPage.lastActiveAt = saved.lastActiveAt ?? null
      if (saved.url && saved.url !== "about:blank" && !saved.url.startsWith("[")) {
        try {
          await browserPage.navigateForUser(saved.url)
        } catch {
          browserPage.url = saved.url
          browserPage.title = saved.title
        }
      } else {
        browserPage.url = saved.url
        browserPage.title = saved.title
      }
      this._page = browserPage
    }

    // Restore annotations
    this._annotations = (data.annotations ?? []) as BrowserAnnotation[]

    return true
  }

  async dispose(): Promise<void> {
    if (this._page) {
      try {
        await this._page.close()
      } catch {
        /* ignore */
      }
    }
    this._page = null

    await this.save()
  }
}
