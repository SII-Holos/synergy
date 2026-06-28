import type { BrowserOwner } from "./owner.js"
import type { BrowserDialogRequest, BrowserDownloadEntry, BrowserFileChooserRequest, BrowserTab } from "./tab.js"

export type BrowserPage = BrowserTab
export type { BrowserTab }

export interface BrowserAnnotation {
  id: string
  pageURL: string
  pageID: string
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
  pageID?: string
  pageURL?: string
}

export interface BrowserSessionObserver {
  onPageCreated?: (page: BrowserPage) => void
  onPageClosed?: (pageID: string) => void
  onPageNavigated?: (page: BrowserPage) => void
  onPageUpdated?: (page: BrowserPage) => void
  onScreenshotAvailable?: (page: BrowserPage, dataUrl: string, width: number, height: number) => void
  onAgentActivity?: (activity: BrowserAgentActivity) => void
  onControlChanged?: (mode: "user" | "agent") => void
  onPageLoadState?: (page: BrowserPage, state: "loading" | "loaded" | "error", message?: string) => void
  onDownload?: (page: BrowserPage, entry: BrowserDownloadEntry) => void
  onFileChooser?: (page: BrowserPage, request: BrowserFileChooserRequest) => void
  onDialog?: (page: BrowserPage, request: BrowserDialogRequest) => void
}

export interface BrowserAgentActivity {
  pageId: string
  url: string
  title?: string
  kind: "reading" | "acting" | "idle"
  tool: string
  label: string
}

export interface BrowserSession {
  readonly owner: BrowserOwner.Info
  readonly page: BrowserPage | null
  readonly annotations: BrowserAnnotation[]

  ensurePage(url?: string): Promise<BrowserPage>
  closePage(): Promise<void>
  getPage(pageID: string): BrowserPage | undefined

  addAnnotation(input: BrowserAnnotationInput): BrowserAnnotation
  removeAnnotation(id: string): boolean
  clearAnnotations(): void
  formatAnnotationsForContext(): string

  addObserver(observer: BrowserSessionObserver): () => void
  notifyPageNavigated(page: BrowserPage): Promise<void>
  notifyAgentActivity(activity: BrowserAgentActivity): Promise<void>
  notifyControlChanged(mode: "user" | "agent"): Promise<void>

  save(): Promise<void>
  restore(): Promise<boolean>
  dispose(): Promise<void>
}
