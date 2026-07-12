import type { BrowserOwner } from "./owner.js"
import type { BrowserCheckpoint, BrowserProtocolErrorData } from "@ericsanchezok/synergy-browser"
import type { BrowserPageBackend } from "./page.js"

export type { BrowserPageBackend }

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
  readonly page: BrowserPageBackend | null
  readonly status: "empty" | "suspended" | "active" | "migrating" | "failed"
  readonly descriptor: {
    id: string
    url: string
    title: string
    lastActiveAt: number | null
  } | null
  readonly checkpoint: BrowserCheckpoint | null
  readonly error: BrowserProtocolErrorData | null
  readonly annotations: BrowserAnnotation[]

  ensurePage(url?: string, options?: { resume?: boolean }): Promise<BrowserPageBackend>
  resumePage(): Promise<BrowserPageBackend>
  closePage(): Promise<void>
  getPage(pageID: string): BrowserPageBackend | undefined

  addAnnotation(input: BrowserAnnotationInput): Promise<BrowserAnnotation>
  removeAnnotation(id: string): Promise<boolean>
  clearAnnotations(): Promise<void>
  formatAnnotationsForContext(): string

  notifyPageNavigated(page: BrowserPageBackend): Promise<void>
  notifyAgentActivity(activity: BrowserAgentActivity): Promise<void>
  notifyControlChanged(mode: "user" | "agent"): Promise<void>

  save(options?: { captureCheckpoint?: boolean }): Promise<void>
  restore(): Promise<boolean>
  dispose(): Promise<void>
}
