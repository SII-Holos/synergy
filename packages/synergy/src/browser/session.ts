import { BrowserOwner } from "./owner.js"
import { BrowserStorage } from "./storage.js"
import { BrowserTabImpl, type BrowserTab } from "./tab.js"
import type { BrowserAnnotation, BrowserAnnotationInput, BrowserSession, BrowserSessionObserver } from "./types.js"
import { BrowserAnnotationHelper } from "./annotation.js"
import type { BrowserDriver } from "./driver.js"
export type { BrowserAnnotation, BrowserAnnotationInput, BrowserSession }

const MAX_TABS = 10

export class BrowserSessionImpl implements BrowserSession {
  readonly owner: BrowserOwner.Info
  private driver: BrowserDriver.Driver
  private _tabs: BrowserTabImpl[] = []
  private _activeTab: BrowserTabImpl | null = null
  private _annotations: BrowserAnnotation[] = []
  private _observers = new Set<BrowserSessionObserver>()

  get tabs(): readonly BrowserTab[] {
    return this._tabs
  }

  get activeTab(): BrowserTab | null {
    return this._activeTab
  }

  get annotations(): BrowserAnnotation[] {
    return this._annotations
  }

  constructor(owner: BrowserOwner.Info, driver: BrowserDriver.Driver) {
    this.owner = owner
    this.driver = driver

    // Restore saved state asynchronously (don't block constructor)
    this.restore().catch(() => {
      /* ignore restore errors on construction */
    })
  }

  async createTab(url?: string): Promise<BrowserTab> {
    if (this._tabs.length >= MAX_TABS) {
      throw new Error(`Maximum of ${MAX_TABS} tabs per session`)
    }

    const page = await this.driver.newPage(this.owner, url)
    const tab = new BrowserTabImpl({
      page,
      directory: this.owner.directory,
    })
    this._tabs.push(tab)

    if (!this._activeTab) {
      this._activeTab = tab
    }

    if (url) {
      try {
        await tab.navigate(url)
      } catch {
        /* navigation may fail; tab still exists */
      }
    }

    await this.save()
    for (const o of this._observers) o.onTabCreated?.(tab)
    return tab
  }

  switchTab(tabID: string): void {
    const tab = this._tabs.find((t) => t.id === tabID)
    if (tab) {
      if (this._activeTab && this._activeTab !== tab) {
        this._activeTab.lastActiveAt = Date.now()
      }
      this._activeTab = tab
    }
  }

  async closeTab(tabID: string): Promise<void> {
    const index = this._tabs.findIndex((t) => t.id === tabID)
    if (index === -1) return

    const tab = this._tabs[index]
    await tab.close()
    this._tabs.splice(index, 1)

    // Switch to another tab if the active one was closed
    if (this._activeTab === tab) {
      if (this._tabs.length > 0) {
        this._activeTab = this._tabs[Math.max(0, index - 1)] ?? this._tabs[0]
      } else {
        this._activeTab = null
      }
    }

    await this.save()
    for (const o of this._observers) o.onTabClosed?.(tabID)
  }

  async closeOthers(tabID: string): Promise<void> {
    const keepTab = this._tabs.find((t) => t.id === tabID)
    if (!keepTab) return

    const toClose = this._tabs.filter((t) => {
      if (t.id === tabID) return false
      if (t.pinned || t.kept) return false
      return true
    })

    for (const tab of toClose) {
      await tab.close()
      const idx = this._tabs.indexOf(tab)
      if (idx !== -1) this._tabs.splice(idx, 1)
    }

    if (!this._tabs.includes(this._activeTab!)) {
      if (this._tabs.length > 0) {
        this._activeTab = this._tabs[0]
      } else {
        this._activeTab = null
      }
    }

    await this.save()
  }

  getTab(tabID: string): BrowserTab | undefined {
    return this._tabs.find((t) => t.id === tabID)
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

  async notifyTabNavigated(tab: BrowserTab): Promise<void> {
    for (const o of this._observers) o.onTabNavigated?.(tab)
  }

  async save(): Promise<void> {
    const state: BrowserStorage.SessionState = {
      tabs: this._tabs.map((tab, i) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        order: i,
        pinned: tab.pinned,
        kept: tab.kept,
        lastActiveAt: tab.lastActiveAt,
      })),
      activeTabID: this._activeTab?.id ?? null,
      panelWidth: 400,
      timestamp: Date.now(),
      annotations: this._annotations,
    }
    await BrowserStorage.save(this.owner, state)
  }

  async restore(): Promise<boolean> {
    const data = await BrowserStorage.load(this.owner)
    if (!data) return false

    // Clear existing tabs
    for (const tab of this._tabs) {
      try {
        await tab.close()
      } catch {
        /* ignore */
      }
    }
    this._tabs = []
    this._activeTab = null

    // Restore tabs sorted by order — create pages via driver
    const sorted = [...data.tabs].sort((a, b) => a.order - b.order)
    for (const saved of sorted) {
      const page = await this.driver.newPage(this.owner)
      const tab = new BrowserTabImpl({ page, directory: this.owner.directory, id: saved.id })
      tab.url = saved.url
      tab.title = saved.title
      tab.pinned = saved.pinned ?? false
      tab.kept = saved.kept ?? false
      tab.lastActiveAt = saved.lastActiveAt ?? null
      this._tabs.push(tab)
    }

    if (data.activeTabID) {
      this._activeTab = this._tabs.find((t) => t.id === data.activeTabID) ?? null
    }
    if (!this._activeTab && this._tabs.length > 0) {
      this._activeTab = this._tabs[0]
    }

    // Restore annotations
    this._annotations = (data.annotations ?? []) as BrowserAnnotation[]

    return true
  }

  async dispose(): Promise<void> {
    for (const tab of this._tabs) {
      try {
        await tab.close()
      } catch {
        /* ignore */
      }
    }
    this._tabs = []
    this._activeTab = null

    await this.save()
  }
}
