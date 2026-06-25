import type { Page } from "playwright"
import type { BrowserOwner } from "./owner.js"

// TAG survives type erasure so BrowserDriver is importable at runtime
export const BrowserDriverTAG = Symbol("BrowserDriver")

export namespace BrowserDriver {
  export const TAG = BrowserDriverTAG

  export interface BrowserContextHandle {
    browserContextId: string
  }

  export interface DriverState {
    running: boolean
    browserType: string
    activeOwners: number
  }

  export interface Driver {
    ensure(): Promise<DriverState>
    stop(): Promise<void>
    contextFor(owner: BrowserOwner.Info): Promise<BrowserContextHandle>
    newPage(owner: BrowserOwner.Info, url?: string): Promise<Page>
    saveContextStorage(owner: BrowserOwner.Info): Promise<void>
    closePage(owner: BrowserOwner.Info, pageId: string): Promise<void>
    getPage(owner: BrowserOwner.Info, pageId: string): Page | undefined
    listOwners(): BrowserOwner.Info[]
  }
}
