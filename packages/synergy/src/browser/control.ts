import type { BrowserSession } from "./types.js"
import type { BrowserTab } from "./tab.js"

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
    | { type: "navigate"; tabId?: string; url: string; source?: "agent" | "user" }
    | { type: "reload"; tabId?: string; ignoreCache?: boolean }
    | { type: "stop"; tabId?: string }
    | { type: "history"; tabId?: string; direction: "back" | "forward" }
    | { type: "setViewport"; tabId?: string; width: number; height: number; deviceScaleFactor?: number }

  export type Result =
    | { type: "tab"; tab: TabState }
    | { type: "navigation"; tab: TabState; url: string; title: string }
    | { type: "session"; session: SessionState }
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
        const result =
          command.source === "user" ? await tab.navigateForUser(command.url) : await tab.navigate(command.url)
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
    }
  }
}
