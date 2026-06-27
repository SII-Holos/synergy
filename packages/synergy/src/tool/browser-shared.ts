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
import { BrowserSnapshot } from "../browser/snapshot"

export class BrowserPageNotFoundError extends Error {
  constructor(pageID?: string) {
    super(pageID ? `Browser page not found: ${pageID}` : "No browser page is open")
    this.name = "BrowserPageNotFoundError"
  }
}

export namespace BrowserToolHelper {
  export async function getOrCreateSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    if (BrowserHostControl.has(owner)) return controlBackedSession(owner)
    return BrowserHost.ensureSession(owner)
  }

  export async function executeControl(
    owner: BrowserOwner.Info,
    command: BrowserControl.Command,
  ): Promise<BrowserControl.Result> {
    return executeBrowserCommand(owner, command)
  }

  export async function getPage(owner: BrowserOwner.Info, pageID?: string): Promise<BrowserTab> {
    const hostPage = controlBackedPageFor(owner, pageID)
    if (hostPage) return hostPage

    const session = await getOrCreateSession(owner)
    if (pageID) {
      const page = session.getPage(pageID)
      if (!page) throw new BrowserPageNotFoundError(pageID)
      return page
    }
    if (!session.page) throw new BrowserPageNotFoundError()
    return session.page
  }

  export async function resolveOrCreatePage(
    session: Pick<BrowserSession, "page" | "ensurePage" | "getPage">,
    pageID?: string,
  ): Promise<BrowserTab> {
    try {
      return await BrowserControl.resolveOrCreatePage(session, pageID)
    } catch (err) {
      if (err instanceof BrowserControl.PageMissingError) throw new BrowserPageNotFoundError(pageID)
      throw err
    }
  }

  export async function getOrCreatePage(
    owner: BrowserOwner.Info,
    pageID?: string,
  ): Promise<{ session: BrowserSession; page: BrowserTab }> {
    if (BrowserHostControl.has(owner)) {
      const session = controlBackedSession(owner)
      const page = session.page
      if (pageID && page?.id !== pageID) throw new BrowserPageNotFoundError(pageID)
      if (!page) throw new BrowserPageNotFoundError()
      return { session, page }
    }

    const session = await getOrCreateSession(owner)
    const page = await resolveOrCreatePage(session, pageID)
    return { session, page }
  }

  export async function navigateWithPolicyApproval(
    ctx: Tool.Context,
    page: BrowserTab,
    url: string,
    owner?: BrowserOwner.Info,
  ): Promise<{ url: string; title: string }> {
    try {
      if (owner) {
        const result = await executeControl(owner, { type: "navigate", pageId: page.id, url })
        if (result.type !== "navigation") throw new Error("Browser navigate command returned an unexpected result")
        return { url: result.url, title: result.title }
      }
      return await page.navigate(url)
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
          pageId: page.id,
          url: err.url,
          policyOverride: true,
        })
        if (result.type !== "navigation") throw new Error("Browser navigate command returned an unexpected result")
        return { url: result.url, title: result.title }
      }
      return page.navigateWithOverride(err.url)
    }
  }

  export async function resolvePage(ctx: Tool.Context, pageId?: string): Promise<BrowserTab> {
    return getPage(BrowserOwner.fromToolContext(ctx), pageId)
  }

  export async function markActivity(
    ctx: Tool.Context,
    page: BrowserTab,
    kind: "reading" | "acting",
    tool: string,
    label: string,
  ): Promise<void> {
    const session = await getOrCreateSession(BrowserOwner.fromToolContext(ctx))
    await session.notifyAgentActivity({
      pageId: page.id,
      url: page.url,
      title: page.title,
      kind,
      tool,
      label,
    })
  }

  export async function markIdle(ctx: Tool.Context, page: BrowserTab, tool: string): Promise<void> {
    const session = await getOrCreateSession(BrowserOwner.fromToolContext(ctx))
    setTimeout(() => {
      session
        .notifyAgentActivity({
          pageId: page.id,
          url: page.url,
          title: page.title,
          kind: "idle",
          tool,
          label: "Idle",
        })
        .catch(() => {})
    }, 450)
  }

  export async function withActivity<T>(
    ctx: Tool.Context,
    page: BrowserTab,
    kind: "reading" | "acting",
    tool: string,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await markActivity(ctx, page, kind, tool, label)
    try {
      return await fn()
    } finally {
      await markIdle(ctx, page, tool)
    }
  }
}

async function executeBrowserCommand(
  owner: BrowserOwner.Info,
  command: BrowserControl.Command,
): Promise<BrowserControl.Result> {
  if (BrowserHostControl.has(owner)) return BrowserHost.executeAttached(owner, command)
  return BrowserHost.executeRuntime(owner, command)
}

function controlBackedPageFor(owner: BrowserOwner.Info, pageID?: string): BrowserTab | null {
  const session = BrowserHostControl.sessionState(owner)
  if (!session?.page) return null
  if (pageID && session.page.id !== pageID) throw new BrowserPageNotFoundError(pageID)
  return controlBackedPage(owner, session.page)
}

function controlBackedSession(owner: BrowserOwner.Info): BrowserSession {
  const annotations: BrowserAnnotation[] = []

  function state(): BrowserControl.SessionState {
    return BrowserHostControl.sessionState(owner) ?? { page: null }
  }

  return {
    owner,
    get page() {
      const page = state().page
      return page ? controlBackedPage(owner, page) : null
    },
    annotations,
    async ensurePage() {
      const page = state().page
      if (!page) throw new BrowserPageNotFoundError()
      return controlBackedPage(owner, page)
    },
    async closePage() {
      throw new Error("Browser workspace pages cannot be closed by tools")
    },
    getPage(pageID: string) {
      const page = state().page
      return page?.id === pageID ? controlBackedPage(owner, page) : undefined
    },
    addAnnotation(input: BrowserAnnotationInput) {
      const annotation: BrowserAnnotation = {
        id: `host-annotation-${Date.now()}-${annotations.length}`,
        pageURL: input.pageURL ?? "",
        pageID: input.pageID ?? "",
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
    async notifyPageNavigated() {},
    async notifyAgentActivity() {},
    async notifyControlChanged() {},
    async save() {},
    async restore() {
      return true
    },
    async dispose() {},
  }
}

function controlBackedPage(owner: BrowserOwner.Info, initial: BrowserControl.PageState): BrowserTab {
  const cdp: CDPHandle = {
    async send<T = unknown>(method: string, params?: Record<string, unknown>) {
      const result = await executeBrowserCommand(owner, { type: "cdp", pageId: page.id, method, params })
      if (result.type !== "cdp") throw new Error("Browser CDP command returned an unexpected result")
      syncFromState(result.pageId)
      return result.value as T
    },
    on() {
      return () => {}
    },
    async detach() {},
  }

  const page: BrowserTab = {
    id: initial.id,
    url: initial.url,
    title: initial.title,
    loading: initial.isLoading,
    pinned: false,
    kept: false,
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
      await executeBrowserCommand(owner, { type: "reload", pageId: page.id, ignoreCache })
    },
    async goBack() {
      await executeBrowserCommand(owner, { type: "history", pageId: page.id, direction: "back" })
    },
    async goForward() {
      await executeBrowserCommand(owner, { type: "history", pageId: page.id, direction: "forward" })
    },
    async stop() {
      await executeBrowserCommand(owner, { type: "stop", pageId: page.id })
    },
    async setViewport(width: number, height: number, deviceScaleFactor?: number) {
      await executeBrowserCommand(owner, { type: "setViewport", pageId: page.id, width, height, deviceScaleFactor })
    },
    async click(x: number, y: number) {
      await executeBrowserCommand(owner, { type: "click", pageId: page.id, x, y })
    },
    async type(text: string) {
      await executeBrowserCommand(owner, { type: "typeText", pageId: page.id, text })
    },
    async scroll(deltaX: number, deltaY: number) {
      await executeBrowserCommand(owner, { type: "scroll", pageId: page.id, deltaX, deltaY })
    },
    async dispatchMouse(action: "move" | "down" | "up" | "wheel", input: BrowserMouseInput) {
      await executeBrowserCommand(owner, { type: "mouse", pageId: page.id, action, input })
    },
    async dispatchKey(action: "down" | "up", input: BrowserKeyInput) {
      await executeBrowserCommand(owner, { type: "key", pageId: page.id, action, input })
    },
    async insertText(text: string) {
      await executeBrowserCommand(owner, { type: "insertText", pageId: page.id, text })
    },
    async respondToFileChooser(requestId, files) {
      await executeBrowserCommand(owner, { type: "filechooser.select", pageId: page.id, requestId, files })
    },
    async respondToDialog(requestId, accept, promptText) {
      await executeBrowserCommand(owner, { type: "dialog.respond", pageId: page.id, requestId, accept, promptText })
    },
    async ensureCDP() {
      return cdp
    },
    async detachCDP() {
      await cdp.detach()
    },
    async screenshot(format, quality, fullPage, clip) {
      const result = await executeBrowserCommand(owner, {
        type: "screenshot",
        pageId: page.id,
        format,
        quality,
        fullPage,
        clip,
      })
      if (result.type !== "screenshot") throw new Error("Browser screenshot command returned an unexpected result")
      syncFromState(result.pageId)
      return { buffer: bufferFromDataUrl(result.dataUrl), width: result.width, height: result.height }
    },
    async snapshot() {
      const result = await executeBrowserCommand(owner, { type: "snapshot", pageId: page.id })
      if (result.type !== "snapshot") throw new Error("Browser snapshot command returned an unexpected result")
      return { elements: result.elements, truncated: result.truncated }
    },
    async consoleEntries(maxEntries?: number) {
      const result = await executeBrowserCommand(owner, { type: "console", pageId: page.id, maxEntries })
      if (result.type !== "console") throw new Error("Browser console command returned an unexpected result")
      return result.entries
    },
    async networkRequests(maxEntries?: number) {
      const result = await executeBrowserCommand(owner, { type: "network", pageId: page.id, maxEntries })
      if (result.type !== "network") throw new Error("Browser network command returned an unexpected result")
      return result.requests
    },
    async clearDiagnostics() {
      await executeBrowserCommand(owner, { type: "clearDiagnostics", pageId: page.id })
    },
    async resolveRef(ref: string) {
      const result = await executeBrowserCommand(owner, { type: "resolveRef", pageId: page.id, ref })
      if (result.type !== "resolvedRef") throw new Error("Browser ref command returned an unexpected result")
      return result.box
    },
    async evaluate(expression, opts) {
      const result = await executeBrowserCommand(owner, {
        type: "evaluate",
        pageId: page.id,
        expression,
        throwOnSideEffect: opts?.throwOnSideEffect,
      })
      if (result.type !== "evaluation") throw new Error("Browser evaluate command returned an unexpected result")
      return result.value
    },
    async waitFor(condition, timeoutMs) {
      return waitForHostCondition(owner, page.id, condition, timeoutMs)
    },
    async close() {
      throw new Error("Browser workspace pages cannot be closed by tools")
    },
  }

  async function navigate(url: string, source?: "agent" | "user", policyOverride?: boolean) {
    const result = await executeBrowserCommand(owner, {
      type: "navigate",
      pageId: page.id,
      url,
      source,
      policyOverride,
    })
    if (result.type !== "navigation") throw new Error("Browser navigate command returned an unexpected result")
    page.url = result.url
    page.title = result.title
    page.loading = result.page.isLoading
    return { url: result.url, title: result.title }
  }

  function syncFromState(pageId: string) {
    const state = BrowserHostControl.sessionState(owner)?.page
    if (!state || state.id !== pageId) return
    page.url = state.url
    page.title = state.title
    page.loading = state.isLoading
    page.lastActiveAt = state.lastActiveAt
  }

  return page
}

async function waitForHostCondition(
  owner: BrowserOwner.Info,
  pageId: string,
  condition: WaitCondition,
  timeoutMs = 5_000,
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    const page = BrowserHostControl.sessionState(owner)?.page
    if (condition.type === "load" && page?.id === pageId && !page.isLoading) return true
    if (condition.type === "url" && page?.id === pageId && page.url.includes(condition.contains)) return true
    if (condition.type === "title" && page?.id === pageId && page.title.includes(condition.contains)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function bufferFromDataUrl(dataUrl: string): Buffer {
  const base64 = dataUrl.split(",", 2)[1] ?? ""
  return Buffer.from(base64, "base64")
}

interface FormatOptions {
  interactiveOnly?: boolean
  maxDepth?: number
}

export function formatSnapshotText(
  elements: import("../browser/tab").AccessibilityElement[],
  options?: FormatOptions,
): string {
  return BrowserSnapshot.formatText(elements, options)
}
