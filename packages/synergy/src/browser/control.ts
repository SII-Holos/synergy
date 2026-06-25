import type { BrowserAnnotation, BrowserSession } from "./types.js"
import { BrowserAssets } from "./assets.js"
import type {
  BrowserTab,
  BrowserUploadFile,
  ConsoleMessage,
  NetworkRequest,
  BrowserDownloadEntry,
  AccessibilityElement,
} from "./tab.js"
import type { BrowserKeyInput, BrowserMouseInput } from "./input.js"

export namespace BrowserControl {
  export interface TabState {
    id: string
    url: string
    title: string
    isLoading: boolean
    pinned: boolean
    kept: boolean
    lastActiveAt: number | null
  }

  export interface SessionState {
    tabs: TabState[]
    activeTabId: string | null
  }

  export type Command =
    | { type: "createTab"; url?: string }
    | { type: "closeTab"; tabId: string }
    | { type: "switchTab"; tabId: string }
    | { type: "navigate"; tabId?: string; url: string; source?: "agent" | "user"; policyOverride?: boolean }
    | { type: "reload"; tabId?: string; ignoreCache?: boolean }
    | { type: "stop"; tabId?: string }
    | { type: "history"; tabId?: string; direction: "back" | "forward" }
    | { type: "setViewport"; tabId?: string; width: number; height: number; deviceScaleFactor?: number }
    | { type: "click"; tabId?: string; x: number; y: number }
    | { type: "typeText"; tabId?: string; text: string }
    | { type: "scroll"; tabId?: string; deltaX: number; deltaY: number }
    | { type: "mouse"; tabId?: string; action: "move" | "down" | "up" | "wheel"; input: BrowserMouseInput }
    | { type: "key"; tabId?: string; action: "down" | "up"; input: BrowserKeyInput }
    | { type: "insertText"; tabId?: string; text: string }
    | { type: "evaluate"; tabId?: string; expression: string; throwOnSideEffect?: boolean }
    | { type: "resolveRef"; tabId?: string; ref: string }
    | { type: "console"; tabId?: string; maxEntries?: number }
    | { type: "network"; tabId?: string; maxEntries?: number }
    | { type: "snapshot"; tabId?: string }
    | { type: "assets"; tabId?: string; maxEntries?: number }
    | {
        type: "screenshot"
        tabId?: string
        format?: "jpeg" | "png"
        quality?: number
        fullPage?: boolean
        clip?: { x: number; y: number; width: number; height: number; scale?: number }
      }
    | { type: "filechooser.select"; tabId?: string; requestId: string; files: BrowserUploadFile[] }
    | { type: "dialog.respond"; tabId?: string; requestId: string; accept: boolean; promptText?: string }
    | {
        type: "createAnnotation"
        tabId?: string
        comment: string
        styleFeedback?: Record<string, string>
      }
    | { type: "clearDiagnostics"; tabId?: string }

  export type Result =
    | { type: "tab"; tab: TabState }
    | { type: "navigation"; tab: TabState; url: string; title: string }
    | { type: "session"; session: SessionState }
    | { type: "console"; tabId: string; entries: ConsoleMessage[] }
    | { type: "network"; tabId: string; requests: NetworkRequest[] }
    | { type: "snapshot"; tabId: string; elements: AccessibilityElement[]; truncated: boolean }
    | { type: "assets"; tabId: string; assets: BrowserAssets.PageAsset[] }
    | { type: "screenshot"; tabId: string; dataUrl: string; width: number; height: number }
    | { type: "evaluation"; tabId: string; value: unknown }
    | {
        type: "resolvedRef"
        tabId: string
        ref: string
        box: { backendNodeId: number; x: number; y: number; width: number; height: number } | null
      }
    | { type: "annotation"; annotation: BrowserAnnotation }
    | { type: "diagnostics.cleared"; tabId: string }
    | { type: "void" }

  export class TabNotFoundError extends Error {
    constructor(tabId?: string) {
      super(tabId ? `Browser tab not found: ${tabId}` : "No active browser tab")
      this.name = "BrowserControlTabNotFoundError"
    }
  }

  export function tabState(tab: BrowserTab): TabState {
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      isLoading: tab.loading,
      pinned: tab.pinned,
      kept: tab.kept,
      lastActiveAt: tab.lastActiveAt,
    }
  }

  export function sessionState(session: BrowserSession): SessionState {
    return {
      tabs: session.tabs.map(tabState),
      activeTabId: session.activeTab?.id ?? null,
    }
  }

  export function resolveTab(session: Pick<BrowserSession, "activeTab" | "getTab">, tabId?: string): BrowserTab {
    if (tabId) {
      const tab = session.getTab(tabId)
      if (!tab) throw new TabNotFoundError(tabId)
      return tab
    }
    if (!session.activeTab) throw new TabNotFoundError()
    return session.activeTab
  }

  export async function resolveOrCreateTab(
    session: Pick<BrowserSession, "activeTab" | "createTab" | "getTab">,
    tabId?: string,
  ): Promise<BrowserTab> {
    if (tabId) {
      const tab = session.getTab(tabId)
      if (!tab) throw new TabNotFoundError(tabId)
      return tab
    }
    return session.activeTab ?? session.createTab()
  }

  export async function execute(session: BrowserSession, command: Command): Promise<Result> {
    switch (command.type) {
      case "createTab": {
        const tab = await session.createTab(command.url)
        session.switchTab(tab.id)
        await session.save()
        return { type: "tab", tab: tabState(tab) }
      }
      case "closeTab": {
        await session.closeTab(command.tabId)
        return { type: "session", session: sessionState(session) }
      }
      case "switchTab": {
        session.switchTab(command.tabId)
        const tab = resolveTab(session, command.tabId)
        return { type: "tab", tab: tabState(tab) }
      }
      case "navigate": {
        const tab = resolveTab(session, command.tabId)
        const result = command.policyOverride
          ? await tab.navigateWithOverride(command.url)
          : command.source === "user"
            ? await tab.navigateForUser(command.url)
            : await tab.navigate(command.url)
        await session.save()
        await session.notifyTabNavigated(tab)
        return { type: "navigation", tab: tabState(tab), url: result.url, title: result.title }
      }
      case "reload": {
        const tab = resolveTab(session, command.tabId)
        await tab.reload(command.ignoreCache)
        await session.save()
        return { type: "void" }
      }
      case "stop": {
        const tab = resolveTab(session, command.tabId)
        await tab.stop()
        return { type: "void" }
      }
      case "history": {
        const tab = resolveTab(session, command.tabId)
        if (command.direction === "back") await tab.goBack()
        else await tab.goForward()
        await session.save()
        return { type: "void" }
      }
      case "setViewport": {
        const tab = resolveTab(session, command.tabId)
        await tab.setViewport(command.width, command.height, command.deviceScaleFactor ?? 1)
        return { type: "tab", tab: tabState(tab) }
      }
      case "click": {
        const tab = resolveTab(session, command.tabId)
        await tab.click(command.x, command.y)
        return { type: "void" }
      }
      case "typeText": {
        const tab = resolveTab(session, command.tabId)
        await tab.type(command.text)
        return { type: "void" }
      }
      case "scroll": {
        const tab = resolveTab(session, command.tabId)
        await tab.scroll(command.deltaX, command.deltaY)
        return { type: "void" }
      }
      case "mouse": {
        const tab = resolveTab(session, command.tabId)
        await tab.dispatchMouse(command.action, command.input)
        return { type: "void" }
      }
      case "key": {
        const tab = resolveTab(session, command.tabId)
        await tab.dispatchKey(command.action, command.input)
        return { type: "void" }
      }
      case "insertText": {
        const tab = resolveTab(session, command.tabId)
        await tab.insertText(command.text)
        return { type: "void" }
      }
      case "evaluate": {
        const tab = resolveTab(session, command.tabId)
        return {
          type: "evaluation",
          tabId: tab.id,
          value: await tab.evaluate(command.expression, { throwOnSideEffect: command.throwOnSideEffect }),
        }
      }
      case "resolveRef": {
        const tab = resolveTab(session, command.tabId)
        return { type: "resolvedRef", tabId: tab.id, ref: command.ref, box: await tab.resolveRef(command.ref) }
      }
      case "console": {
        const tab = resolveTab(session, command.tabId)
        return { type: "console", tabId: tab.id, entries: await tab.consoleEntries(command.maxEntries ?? 50) }
      }
      case "network": {
        const tab = resolveTab(session, command.tabId)
        return { type: "network", tabId: tab.id, requests: await tab.networkRequests(command.maxEntries ?? 100) }
      }
      case "snapshot": {
        const tab = resolveTab(session, command.tabId)
        const snapshot = await tab.snapshot()
        return { type: "snapshot", tabId: tab.id, elements: snapshot.elements, truncated: snapshot.truncated }
      }
      case "assets": {
        const tab = resolveTab(session, command.tabId)
        const requests = await tab.networkRequests(command.maxEntries ?? 200)
        return { type: "assets", tabId: tab.id, assets: BrowserAssets.fromNetworkBuffer(requests, tab.id) }
      }
      case "screenshot": {
        const tab = resolveTab(session, command.tabId)
        const shot = await tab.screenshot(command.format, command.quality, command.fullPage, command.clip)
        const mime = command.format === "jpeg" ? "image/jpeg" : "image/png"
        return {
          type: "screenshot",
          tabId: tab.id,
          dataUrl: `data:${mime};base64,${shot.buffer.toString("base64")}`,
          width: shot.width,
          height: shot.height,
        }
      }
      case "filechooser.select": {
        const tab = resolveTab(session, command.tabId)
        await tab.respondToFileChooser(command.requestId, command.files)
        return { type: "void" }
      }
      case "dialog.respond": {
        const tab = resolveTab(session, command.tabId)
        await tab.respondToDialog(command.requestId, command.accept, command.promptText)
        return { type: "void" }
      }
      case "createAnnotation": {
        const annotation = session.addAnnotation({
          comment: command.comment,
          styleFeedback: command.styleFeedback,
          createdBy: "user",
          tabID: command.tabId,
        })
        return { type: "annotation", annotation }
      }
      case "clearDiagnostics": {
        const tab = resolveTab(session, command.tabId)
        await tab.clearDiagnostics()
        return { type: "diagnostics.cleared", tabId: tab.id }
      }
    }
  }
}
