import type { Tool } from "./tool"
import { Instance } from "../scope/instance"

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
    directory: string
    sessionID?: string
    browserSession?: BrowserSession
  }

  /** Resolve a BrowserSession from tool context. Creates one if needed. */
  export async function getOrCreateSession(ctx: Context): Promise<BrowserSession> {
    if (ctx.browserSession) return ctx.browserSession

    const key: BrowserRuntime.SessionKey = {
      scopeID: ctx.scopeID,
      sessionID: ctx.sessionID,
    }

    const state = BrowserRuntime.state()
    const existing = state.sessions.get(`${ctx.scopeID}:${ctx.sessionID ?? "default"}`) as BrowserSession | undefined
    if (existing) return existing

    // Dynamic import to avoid circular deps
    const { BrowserSessionImpl } = await import("../browser/session.js")
    return new BrowserSessionImpl(key, ctx.directory) as BrowserSession
  }

  /** Resolve the active tab, or throw BrowserTabNotFoundError. */
  export async function getActiveTab(ctx: Context): Promise<BrowserTab> {
    const session = await getOrCreateSession(ctx)
    const tab = session.activeTab
    if (!tab) throw new BrowserTabNotFoundError()
    return tab
  }

  /** Resolve a specific tab by ID, or active if no ID given. */
  export async function getTab(ctx: Context, tabID?: string): Promise<BrowserTab> {
    const session = await getOrCreateSession(ctx)
    if (tabID) {
      const tab = session.getTab(tabID)
      if (!tab) throw new BrowserTabNotFoundError(tabID)
      return tab
    }
    const tab = session.activeTab
    if (!tab) throw new BrowserTabNotFoundError()
    return tab
  }

  /** One-call convenience: ensure runtime, create context, resolve tab. */
  export async function resolveTab(ctx: Tool.Context, tabId?: string): Promise<BrowserTab> {
    await BrowserRuntime.ensure()
    const helperCtx: Context = {
      scopeID: Instance.scope.id,
      directory: Instance.directory,
      sessionID: ctx.sessionID,
    }
    return getTab(helperCtx, tabId)
  }
}

// ── Snapshot text formatter ──────────────────────────────────────────

import { STRUCTURAL_ROLES } from "../browser/tab"

interface FormatOptions {
  interactiveOnly?: boolean
  maxDepth?: number
}

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
