import type { Tool } from "./tool"

import { BrowserRuntime } from "../browser/runtime"
import type { BrowserSession } from "../browser/types.js"
import type { BrowserTab } from "../browser/tab"
import { BrowserOwner } from "../browser/owner"

// ── Shared error classes ───────────────────────────────────────────────

export class BrowserTabNotFoundError extends Error {
  constructor(tabID?: string) {
    super(tabID ? `Browser tab not found: ${tabID}` : "No active browser tab")
    this.name = "BrowserTabNotFoundError"
  }
}

export namespace BrowserToolHelper {
  /** Resolve a BrowserSession from a BrowserOwner. Creates one if needed. */
  export async function getOrCreateSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    return BrowserRuntime.getOrCreateSession(owner)
  }

  /** Resolve the active tab, or throw BrowserTabNotFoundError. */
  export async function getActiveTab(owner: BrowserOwner.Info): Promise<BrowserTab> {
    const session = await getOrCreateSession(owner)
    const tab = session.activeTab
    if (!tab) throw new BrowserTabNotFoundError()
    return tab
  }

  /** Resolve a specific tab by ID, or active if no ID given. */
  export async function getTab(owner: BrowserOwner.Info, tabID?: string): Promise<BrowserTab> {
    const session = await getOrCreateSession(owner)
    if (tabID) {
      const tab = session.getTab(tabID)
      if (!tab) throw new BrowserTabNotFoundError(tabID)
      return tab
    }
    const tab = session.activeTab
    if (!tab) throw new BrowserTabNotFoundError()
    return tab
  }

  /** One-call convenience: ensure runtime, derive owner, resolve tab. */
  export async function resolveTab(ctx: Tool.Context, tabId?: string): Promise<BrowserTab> {
    await BrowserRuntime.ensure()
    return getTab(BrowserOwner.fromToolContext(ctx), tabId)
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
