import type { Tool } from "./tool"

import type { BrowserSession } from "../browser/types.js"
import type { BrowserAnnotation, BrowserAnnotationInput } from "../browser/types.js"
import { BlockedURLNavigationError, type BrowserTab, type WaitCondition } from "../browser/tab"
import { BrowserOwner } from "../browser/owner"
import { BrowserControl } from "../browser/control"
import { BrowserHost } from "../browser/host"
import { BrowserHostControl } from "../browser/host-control"
import type { CDPHandle } from "../browser/cdp"
import type { BrowserKeyInput, BrowserMouseInput } from "../browser/input"

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
    if (BrowserHostControl.has(owner)) return controlBackedSession(owner)
    return BrowserHost.ensureSession(owner)
  }

  export async function executeControl(
    owner: BrowserOwner.Info,
    command: BrowserControl.Command,
  ): Promise<BrowserControl.Result> {
    return BrowserHost.execute(owner, command)
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
    const hostTab = controlBackedTabFor(owner, tabID)
    if (hostTab) return hostTab

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

  export async function resolveOrCreateTab(
    session: Pick<BrowserSession, "activeTab" | "createTab" | "getTab">,
    tabID?: string,
  ): Promise<BrowserTab> {
    try {
      return await BrowserControl.resolveOrCreateTab(session, tabID)
    } catch (err) {
      if (err instanceof BrowserControl.TabNotFoundError) throw new BrowserTabNotFoundError(tabID)
      throw err
    }
  }

  export async function getOrCreateTab(
    owner: BrowserOwner.Info,
    tabID?: string,
  ): Promise<{ session: BrowserSession; tab: BrowserTab }> {
    if (BrowserHostControl.has(owner)) {
      const session = controlBackedSession(owner)
      if (tabID) {
        const tab = session.getTab(tabID)
        if (!tab) throw new BrowserTabNotFoundError(tabID)
        return { session, tab }
      }
      if (session.activeTab) return { session, tab: session.activeTab }
      const result = await executeControl(owner, { type: "createTab" })
      if (result.type !== "tab") throw new Error("Browser create tab command returned an unexpected result")
      return { session, tab: controlBackedTab(owner, result.tab) }
    }

    const session = await getOrCreateSession(owner)
    const tab = await resolveOrCreateTab(session, tabID)
    return { session, tab }
  }

  export async function navigateWithPolicyApproval(
    ctx: Tool.Context,
    tab: BrowserTab,
    url: string,
    owner?: BrowserOwner.Info,
  ): Promise<{ url: string; title: string }> {
    try {
      if (owner) {
        const result = await executeControl(owner, { type: "navigate", tabId: tab.id, url })
        if (result.type !== "navigation") throw new Error("Browser navigate command returned an unexpected result")
        return { url: result.url, title: result.title }
      }
      return await tab.navigate(url)
    } catch (err) {
      if (!(err instanceof BlockedURLNavigationError)) throw err
      await ctx.ask({
        permission: "network_request",
        patterns: [err.url],
        metadata: {
          nonBypassable: false,
          capability: "network_request",
          reason: err.message,
        },
      })
      if (owner) {
        const result = await executeControl(owner, {
          type: "navigate",
          tabId: tab.id,
          url: err.url,
          policyOverride: true,
        })
        if (result.type !== "navigation") throw new Error("Browser navigate command returned an unexpected result")
        return { url: result.url, title: result.title }
      }
      return tab.navigateWithOverride(err.url)
    }
  }

  /** One-call convenience: ensure runtime, derive owner, resolve tab. */
  export async function resolveTab(ctx: Tool.Context, tabId?: string): Promise<BrowserTab> {
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

function controlBackedTabFor(owner: BrowserOwner.Info, tabID?: string): BrowserTab | null {
  const session = BrowserHostControl.sessionState(owner)
  if (!session) return null
  const tab = tabID
    ? session.tabs.find((item) => item.id === tabID)
    : session.tabs.find((item) => item.id === session.activeTabId)
  if (!tab) {
    if (tabID) throw new BrowserTabNotFoundError(tabID)
    throw new BrowserTabNotFoundError()
  }
  return controlBackedTab(owner, tab)
}

function controlBackedSession(owner: BrowserOwner.Info): BrowserSession {
  const annotations: BrowserAnnotation[] = []

  function state(): BrowserControl.SessionState {
    return BrowserHostControl.sessionState(owner) ?? { tabs: [], activeTabId: null }
  }

  return {
    owner,
    get tabs() {
      return state().tabs.map((tab) => controlBackedTab(owner, tab))
    },
    get activeTab() {
      const current = state()
      const tab = current.tabs.find((item) => item.id === current.activeTabId)
      return tab ? controlBackedTab(owner, tab) : null
    },
    annotations,
    async createTab(url?: string) {
      const result = await BrowserHost.execute(owner, { type: "createTab", url })
      if (result.type !== "tab") throw new Error("Browser create tab command returned an unexpected result")
      return controlBackedTab(owner, result.tab)
    },
    switchTab(tabID: string) {
      void BrowserHost.execute(owner, { type: "switchTab", tabId: tabID })
    },
    async closeTab(tabID: string) {
      await BrowserHost.execute(owner, { type: "closeTab", tabId: tabID })
    },
    async closeOthers(tabID: string) {
      const current = state()
      for (const tab of current.tabs) {
        if (tab.id === tabID || tab.pinned || tab.kept) continue
        await BrowserHost.execute(owner, { type: "closeTab", tabId: tab.id })
      }
    },
    getTab(tabID: string) {
      const tab = state().tabs.find((item) => item.id === tabID)
      return tab ? controlBackedTab(owner, tab) : undefined
    },
    addAnnotation(input: BrowserAnnotationInput) {
      const annotation: BrowserAnnotation = {
        id: `host-annotation-${Date.now()}-${annotations.length}`,
        tabURL: input.tabURL ?? "",
        tabID: input.tabID ?? "",
        ref: input.ref,
        element: input.element,
        comment: input.comment,
        styleFeedback: input.styleFeedback,
        resolved: false,
        createdAt: Date.now(),
      }
      annotations.push(annotation)
      return annotation
    },
    removeAnnotation(id: string) {
      const index = annotations.findIndex((item) => item.id === id)
      if (index === -1) return false
      annotations.splice(index, 1)
      return true
    },
    clearAnnotations() {
      annotations.length = 0
    },
    formatAnnotationsForContext() {
      return ""
    },
    addObserver() {
      return () => {}
    },
    async notifyTabNavigated() {},
    async notifyAgentActivity() {},
    async notifyControlChanged() {},
    async save() {},
    async restore() {
      return true
    },
    async dispose() {},
  }
}

function controlBackedTab(owner: BrowserOwner.Info, initial: BrowserControl.TabState): BrowserTab {
  const cdp: CDPHandle = {
    async send<T = unknown>(method: string, params?: Record<string, unknown>) {
      const result = await BrowserHost.execute(owner, { type: "cdp", tabId: tab.id, method, params })
      if (result.type !== "cdp") throw new Error("Browser CDP command returned an unexpected result")
      syncFromState(result.tabId)
      return result.value as T
    },
    on() {
      return () => {}
    },
    async detach() {},
  }

  const tab: BrowserTab = {
    id: initial.id,
    url: initial.url,
    title: initial.title,
    loading: initial.isLoading,
    pinned: initial.pinned,
    kept: initial.kept,
    lastActiveAt: initial.lastActiveAt,
    cdp,
    async navigate(url: string) {
      return navigate(url)
    },
    async navigateForUser(url: string) {
      return navigate(url, "user")
    },
    async navigateWithOverride(url: string) {
      return navigate(url, undefined, true)
    },
    async reload(ignoreCache?: boolean) {
      await BrowserHost.execute(owner, { type: "reload", tabId: tab.id, ignoreCache })
    },
    async goBack() {
      await BrowserHost.execute(owner, { type: "history", tabId: tab.id, direction: "back" })
    },
    async goForward() {
      await BrowserHost.execute(owner, { type: "history", tabId: tab.id, direction: "forward" })
    },
    async stop() {
      await BrowserHost.execute(owner, { type: "stop", tabId: tab.id })
    },
    async setViewport(width: number, height: number, deviceScaleFactor?: number) {
      await BrowserHost.execute(owner, { type: "setViewport", tabId: tab.id, width, height, deviceScaleFactor })
    },
    async click(x: number, y: number) {
      await BrowserHost.execute(owner, { type: "click", tabId: tab.id, x, y })
    },
    async type(text: string) {
      await BrowserHost.execute(owner, { type: "typeText", tabId: tab.id, text })
    },
    async scroll(deltaX: number, deltaY: number) {
      await BrowserHost.execute(owner, { type: "scroll", tabId: tab.id, deltaX, deltaY })
    },
    async dispatchMouse(action: "move" | "down" | "up" | "wheel", input: BrowserMouseInput) {
      await BrowserHost.execute(owner, { type: "mouse", tabId: tab.id, action, input })
    },
    async dispatchKey(action: "down" | "up", input: BrowserKeyInput) {
      await BrowserHost.execute(owner, { type: "key", tabId: tab.id, action, input })
    },
    async insertText(text: string) {
      await BrowserHost.execute(owner, { type: "insertText", tabId: tab.id, text })
    },
    async respondToFileChooser(requestId, files) {
      await BrowserHost.execute(owner, { type: "filechooser.select", tabId: tab.id, requestId, files })
    },
    async respondToDialog(requestId, accept, promptText) {
      await BrowserHost.execute(owner, { type: "dialog.respond", tabId: tab.id, requestId, accept, promptText })
    },
    async ensureCDP() {
      return cdp
    },
    async detachCDP() {
      await cdp.detach()
    },
    async screenshot(format, quality, fullPage, clip) {
      const result = await BrowserHost.execute(owner, {
        type: "screenshot",
        tabId: tab.id,
        format,
        quality,
        fullPage,
        clip,
      })
      if (result.type !== "screenshot") throw new Error("Browser screenshot command returned an unexpected result")
      syncFromState(result.tabId)
      return { buffer: bufferFromDataUrl(result.dataUrl), width: result.width, height: result.height }
    },
    async snapshot() {
      const result = await BrowserHost.execute(owner, { type: "snapshot", tabId: tab.id })
      if (result.type !== "snapshot") throw new Error("Browser snapshot command returned an unexpected result")
      return { elements: result.elements, truncated: result.truncated }
    },
    async consoleEntries(maxEntries?: number) {
      const result = await BrowserHost.execute(owner, { type: "console", tabId: tab.id, maxEntries })
      if (result.type !== "console") throw new Error("Browser console command returned an unexpected result")
      return result.entries
    },
    async networkRequests(maxEntries?: number) {
      const result = await BrowserHost.execute(owner, { type: "network", tabId: tab.id, maxEntries })
      if (result.type !== "network") throw new Error("Browser network command returned an unexpected result")
      return result.requests
    },
    async clearDiagnostics() {
      await BrowserHost.execute(owner, { type: "clearDiagnostics", tabId: tab.id })
    },
    async resolveRef(ref: string) {
      const result = await BrowserHost.execute(owner, { type: "resolveRef", tabId: tab.id, ref })
      if (result.type !== "resolvedRef") throw new Error("Browser ref command returned an unexpected result")
      return result.box
    },
    async evaluate(expression, opts) {
      const result = await BrowserHost.execute(owner, {
        type: "evaluate",
        tabId: tab.id,
        expression,
        throwOnSideEffect: opts?.throwOnSideEffect,
      })
      if (result.type !== "evaluation") throw new Error("Browser evaluate command returned an unexpected result")
      return result.value
    },
    async waitFor(condition, timeoutMs) {
      return waitForHostCondition(owner, tab.id, condition, timeoutMs)
    },
    async close() {
      await BrowserHost.execute(owner, { type: "closeTab", tabId: tab.id })
    },
  }

  async function navigate(url: string, source?: "agent" | "user", policyOverride?: boolean) {
    const result = await BrowserHost.execute(owner, { type: "navigate", tabId: tab.id, url, source, policyOverride })
    if (result.type !== "navigation") throw new Error("Browser navigate command returned an unexpected result")
    tab.url = result.url
    tab.title = result.title
    tab.loading = result.tab.isLoading
    return { url: result.url, title: result.title }
  }

  function syncFromState(tabId: string) {
    const state = BrowserHostControl.sessionState(owner)?.tabs.find((item) => item.id === tabId)
    if (!state) return
    tab.url = state.url
    tab.title = state.title
    tab.loading = state.isLoading
    tab.pinned = state.pinned
    tab.kept = state.kept
    tab.lastActiveAt = state.lastActiveAt
  }

  return tab
}

async function waitForHostCondition(
  owner: BrowserOwner.Info,
  tabId: string,
  condition: WaitCondition,
  timeoutMs = 5_000,
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    const tab = BrowserHostControl.sessionState(owner)?.tabs.find((item) => item.id === tabId)
    if (condition.type === "load" && tab && !tab.isLoading) return true
    if (condition.type === "url" && tab?.url.includes(condition.contains)) return true
    if (condition.type === "title" && tab?.title.includes(condition.contains)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function bufferFromDataUrl(dataUrl: string): Buffer {
  const base64 = dataUrl.split(",", 2)[1] ?? ""
  return Buffer.from(base64, "base64")
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
