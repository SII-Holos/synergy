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

  export async function markActivity(
    ctx: Tool.Context,
    tab: BrowserTab,
    kind: "reading" | "acting",
    tool: string,
    label: string,
  ): Promise<void> {
    const session = await getOrCreateSession(BrowserOwner.fromToolContext(ctx))
    await session.notifyAgentActivity({
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      kind,
      tool,
      label,
    })
  }

  export async function markIdle(ctx: Tool.Context, tab: BrowserTab, tool: string): Promise<void> {
    const session = await getOrCreateSession(BrowserOwner.fromToolContext(ctx))
    setTimeout(() => {
      session
        .notifyAgentActivity({
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          kind: "idle",
          tool,
          label: "Idle",
        })
        .catch(() => {})
    }, 450)
  }

  export async function withActivity<T>(
    ctx: Tool.Context,
    tab: BrowserTab,
    kind: "reading" | "acting",
    tool: string,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await markActivity(ctx, tab, kind, tool, label)
    try {
      return await fn()
    } finally {
      await markIdle(ctx, tab, tool)
    }
  }
}

// ── Snapshot text formatter ──────────────────────────────────────────

interface FormatOptions {
  interactiveOnly?: boolean
  maxDepth?: number
}

import { BrowserSnapshot } from "../browser/snapshot"

export function formatSnapshotText(
  elements: import("../browser/tab").AccessibilityElement[],
  options?: FormatOptions,
): string {
  return BrowserSnapshot.formatText(elements, options)
}
