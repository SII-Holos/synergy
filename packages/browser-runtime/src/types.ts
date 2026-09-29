import type { BrowserOwner } from "./owner.js"
import type { BrowserSessionPage } from "@ericsanchezok/synergy-browser-core"
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
  readonly pages: BrowserSessionPage[]
  readonly status: "empty" | "suspended" | "active" | "failed"
  readonly annotations: BrowserAnnotation[]

  openPage(input: { url?: string; profileId?: string; requestId?: string }): Promise<BrowserPageBackend>
  resumePage(pageId: string): Promise<BrowserPageBackend>
  closePage(pageId: string): Promise<void>
  suspendProfile(profileId: string): Promise<void>
  getPage(pageId: string): BrowserPageBackend | undefined

  addAnnotation(input: BrowserAnnotationInput): Promise<BrowserAnnotation>
  removeAnnotation(id: string): Promise<boolean>
  clearAnnotations(): Promise<void>
  formatAnnotationsForContext(): string

  notifyPageNavigated(page: BrowserPageBackend): Promise<void>
  notifyAgentActivity(activity: BrowserAgentActivity): Promise<void>

  save(): Promise<void>
  restore(): Promise<boolean>
  dispose(): Promise<void>
}
