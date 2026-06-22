import { BrowserRuntime } from "../browser/runtime"
import type { BrowserSession } from "../browser/session"
import type { BrowserTab } from "../browser/tab"

// ── Shared error classes ───────────────────────────────────────────────

export class BrowserNotReadyError extends Error {
  constructor(message = "Browser runtime is not ready") {
    super(message)
    this.name = "BrowserNotReadyError"
  }
}

export class BrowserPolicyDeniedError extends Error {
  constructor(reason: string) {
    super(`Browser policy denied: ${reason}`)
    this.name = "BrowserPolicyDeniedError"
  }
}

export class BrowserTabNotFoundError extends Error {
  constructor(tabID?: string) {
    super(tabID ? `Browser tab not found: ${tabID}` : "No active browser tab")
    this.name = "BrowserTabNotFoundError"
  }
}

// ── Shared helper namespace ────────────────────────────────────────────

export namespace BrowserToolHelper {
  export interface Context {
    scopeID: string
    sessionID?: string
    browserSession?: BrowserSession
  }

  /** Resolve a BrowserSession from tool context. Creates one if needed. */
  export function getOrCreateSession(ctx: Context): BrowserSession {
    if (ctx.browserSession) return ctx.browserSession

    const key: BrowserRuntime.SessionKey = {
      scopeID: ctx.scopeID,
      sessionID: ctx.sessionID,
    }

    const state = BrowserRuntime.state()
    const existing = state.sessions.get(`${ctx.scopeID}:${ctx.sessionID ?? "default"}`) as BrowserSession | undefined
    if (existing) return existing

    // Lazy-import to avoid circular deps
    const { BrowserSessionImpl } = require("../browser/session") as {
      BrowserSessionImpl: new (key: BrowserRuntime.SessionKey, workspace: string) => BrowserSession
    }
    return new BrowserSessionImpl(key, ctx.scopeID)
  }

  /** Resolve the active tab, or throw BrowserTabNotFoundError. */
  export function getActiveTab(ctx: Context): BrowserTab {
    const session = getOrCreateSession(ctx)
    const tab = session.activeTab
    if (!tab) throw new BrowserTabNotFoundError()
    return tab
  }

  /** Resolve a specific tab by ID, or active if no ID given. */
  export function getTab(ctx: Context, tabID?: string): BrowserTab {
    const session = getOrCreateSession(ctx)
    if (tabID) {
      const tab = session.getTab(tabID)
      if (!tab) throw new BrowserTabNotFoundError(tabID)
      return tab
    }
    const tab = session.activeTab
    if (!tab) throw new BrowserTabNotFoundError()
    return tab
  }
}

// ── Snapshot text formatter ──────────────────────────────────────────

interface FormatOptions {
  interactiveOnly?: boolean
  maxDepth?: number
}

const STRUCTURAL_ROLES = new Set([
  "heading",
  "main",
  "navigation",
  "nav",
  "section",
  "article",
  "group",
  "list",
  "listitem",
  "region",
  "document",
  "dialog",
  "application",
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "search",
  "row",
  "table",
  "grid",
  "rowgroup",
  "columnheader",
  "rowheader",
  "gridcell",
  "paragraph",
  "generic",
])

const MAX_OUTPUT_LENGTH = 6000

export function formatSnapshotText(
  elements: import("../browser/tab").AccessibilityElement[],
  options?: FormatOptions,
): string {
  const maxDepth = options?.maxDepth ?? Infinity
  const interactiveOnly = options?.interactiveOnly ?? false
  let output = ""

  function walk(nodes: import("../browser/tab").AccessibilityElement[], depth: number): boolean {
    if (depth > maxDepth) return false
    if (output.length > MAX_OUTPUT_LENGTH) return false

    for (const el of nodes) {
      const isInteractive = !!el.ref
      const isStructural = STRUCTURAL_ROLES.has(el.role)
      const hasChildren = el.children.length > 0

      if (!isInteractive && !isStructural && !hasChildren) continue
      if (interactiveOnly && !isInteractive && !hasChildren) {
        // Still walk children but don't print this node
        walk(el.children, depth + 1)
        continue
      }

      const indent = "  ".repeat(depth)
      const name = el.name ? ` "${el.name}"` : ""
      const ref = el.ref ? ` [ref=${el.ref}]` : ""
      output += `${indent}- ${el.role}${name}${ref}\n`

      if (output.length > MAX_OUTPUT_LENGTH) {
        output += `${indent}  ... (truncated)\n`
        return false
      }

      if (!walk(el.children, depth + 1)) return false
    }
    return true
  }

  walk(elements, 0)
  return output.trimEnd()
}
