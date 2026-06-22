import type { BrowserOwner } from "./owner.js"
import type { BrowserTab } from "./tab.js"

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

export interface BrowserSession {
  readonly owner: BrowserOwner.Info
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
