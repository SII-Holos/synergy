import type { BrowserOwner } from "./owner.js"
import type { BrowserDialogRequest, BrowserDownloadEntry, BrowserFileChooserRequest, BrowserTab } from "./tab.js"

export type { BrowserTab }

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

export interface BrowserSessionObserver {
  onTabCreated?: (tab: BrowserTab) => void
  onTabClosed?: (tabID: string) => void
  onTabNavigated?: (tab: BrowserTab) => void
  onTabUpdated?: (tab: BrowserTab) => void
  onTabActivated?: (tab: BrowserTab) => void
  onScreenshotAvailable?: (tab: BrowserTab, dataUrl: string, width: number, height: number) => void
  onAgentActivity?: (activity: BrowserAgentActivity) => void
  onControlChanged?: (mode: "user" | "agent") => void
  onPageLoadState?: (tab: BrowserTab, state: "loading" | "loaded" | "error", message?: string) => void
  onDownload?: (tab: BrowserTab, entry: BrowserDownloadEntry) => void
  onFileChooser?: (tab: BrowserTab, request: BrowserFileChooserRequest) => void
  onDialog?: (tab: BrowserTab, request: BrowserDialogRequest) => void
}

export interface BrowserAgentActivity {
  tabId: string
  url: string
  title?: string
  kind: "reading" | "acting" | "idle"
  tool: string
  label: string
}

export interface BrowserSession {
  readonly owner: BrowserOwner.Info
  readonly tabs: readonly BrowserTab[]
  readonly activeTab: BrowserTab | null
  readonly annotations: BrowserAnnotation[]

  createTab(url?: string): Promise<BrowserTab>
  switchTab(tabID: string): void
  closeTab(tabID: string): Promise<void>
  closeOthers(tabID: string): Promise<void>
  getTab(tabID: string): BrowserTab | undefined

  addAnnotation(input: BrowserAnnotationInput): BrowserAnnotation
  removeAnnotation(id: string): boolean
  clearAnnotations(): void
  formatAnnotationsForContext(): string

  addObserver(observer: BrowserSessionObserver): () => void
  notifyTabNavigated(tab: BrowserTab): Promise<void>
  notifyAgentActivity(activity: BrowserAgentActivity): Promise<void>
  notifyControlChanged(mode: "user" | "agent"): Promise<void>

  save(): Promise<void>
  restore(): Promise<boolean>
  dispose(): Promise<void>
}
