import { BrowserRuntime } from "./runtime.js"
import { BrowserStorage } from "./storage.js"
import { BrowserTabImpl, type BrowserTab } from "./tab.js"

export interface BrowserAnnotation {
  id: string
  tabURL: string
  tabID: string
  ref?: string
  element?: string
  comment: string
  styleFeedback?: Record<string, string>
  resolved: boolean
  createdAt: number
}

export interface BrowserAnnotationInput {
  ref?: string
  element?: string
  comment: string
  styleFeedback?: Record<string, string>
  createdBy: "user" | "agent"
  tabID?: string
  tabURL?: string
}
export interface BrowserSession {
  readonly key: BrowserRuntime.SessionKey
  readonly tabs: readonly BrowserTab[]
  readonly activeTab: BrowserTab | null
  readonly annotations: BrowserAnnotation[]

  createTab(url?: string): Promise<BrowserTab>
  switchTab(tabID: string): void
  closeTab(tabID: string): Promise<void>
  getTab(tabID: string): BrowserTab | undefined

  addAnnotation(input: BrowserAnnotationInput): BrowserAnnotation
  removeAnnotation(id: string): boolean
  clearAnnotations(): void
  formatAnnotationsForContext(): string

  save(): Promise<void>
  restore(): Promise<boolean>

  dispose(): Promise<void>
}

const MAX_TABS = 10

export class BrowserSessionImpl implements BrowserSession {
  readonly key: BrowserRuntime.SessionKey
  private _tabs: BrowserTabImpl[] = []
  private _activeTab: BrowserTabImpl | null = null
  private _annotations: BrowserAnnotation[] = []
  private workspace: string

  get tabs(): readonly BrowserTab[] {
    return this._tabs
  }

  get activeTab(): BrowserTab | null {
    return this._activeTab
  }

  get annotations(): BrowserAnnotation[] {
    return this._annotations
  }

  constructor(key: BrowserRuntime.SessionKey, workspace: string) {
    this.key = key
    this.workspace = workspace

    // Register session with runtime
    BrowserRuntime.registerSession(key, this as unknown as import("./runtime.js").BrowserSession)

    // Restore saved state asynchronously (don't block constructor)
    this.restore().catch(() => {
      /* ignore restore errors on construction */
    })
  }

  private async ensureScopeContext(): Promise<string> {
    return BrowserRuntime.scopeTarget(this.key.scopeID)
  }

  async createTab(url?: string): Promise<BrowserTab> {
    if (this._tabs.length >= MAX_TABS) {
      throw new Error(`Maximum of ${MAX_TABS} tabs per session`)
    }

    const state = BrowserRuntime.state()
    if (!state.cdpConnection) {
      throw new Error("Browser is not running")
    }
    const browserContextId = await this.ensureScopeContext()
    const tab = new BrowserTabImpl(state.cdpConnection, this.workspace, undefined, browserContextId)
    this._tabs.push(tab)

    if (!this._activeTab) {
      this._activeTab = tab
    }

    if (url) {
      await tab.navigate(url)
    }

    await this.save()
    return tab
  }

  switchTab(tabID: string): void {
    const tab = this._tabs.find((t) => t.id === tabID)
    if (tab) {
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
  }

  getTab(tabID: string): BrowserTab | undefined {
    return this._tabs.find((t) => t.id === tabID)
  }

  addAnnotation(input: BrowserAnnotationInput): BrowserAnnotation {
    const id = crypto.randomUUID()
    const annotation: BrowserAnnotation = {
      id,
      tabURL: input.tabURL ?? "",
      tabID: input.tabID ?? "",
      ref: input.ref,
      element: input.element,
      comment: input.comment,
      styleFeedback: input.styleFeedback,
      resolved: false,
      createdAt: Date.now(),
    }
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
    const pending = this._annotations.filter((a) => !a.resolved)
    if (pending.length === 0) return ""
    const items = pending
      .map(
        (a) =>
          `  <browser-annotation id="${a.id}"${a.ref ? ` ref="${a.ref}"` : ""}${a.element ? ` element="${a.element}"` : ""}${a.tabURL ? ` tab="${a.tabURL}"` : ""}>
    ${a.comment}${a.styleFeedback ? `\n    style-feedback: ${JSON.stringify(a.styleFeedback)}` : ""}
  </browser-annotation>`,
      )
      .join("\n")
    return `<browser-annotations>\n${items}\n</browser-annotations>`
  }

  async save(): Promise<void> {
    const state: BrowserStorage.SessionState = {
      scopeID: this.key.scopeID,
      sessionID: this.key.sessionID,
      tabs: this._tabs.map((tab, i) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        order: i,
      })),
      activeTabID: this._activeTab?.id ?? null,
      panelWidth: 400,
      timestamp: Date.now(),
      annotations: this._annotations,
    }
    await BrowserStorage.save(state)
  }

  async restore(): Promise<boolean> {
    const data = await BrowserStorage.load(this.key)
    if (!data) return false

    const state = BrowserRuntime.state()
    if (!state.cdpConnection) return false

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

    // Restore tabs sorted by order
    const sorted = [...data.tabs].sort((a, b) => a.order - b.order)
    for (const saved of sorted) {
      const tab = new BrowserTabImpl(state.cdpConnection, this.workspace, saved.id)
      tab.url = saved.url
      tab.title = saved.title
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
