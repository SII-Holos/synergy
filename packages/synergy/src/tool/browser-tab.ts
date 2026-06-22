import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { BrowserOwner } from "../browser/owner"

interface TabSummary {
  id: string
  url: string
  title: string
  active: boolean
}

interface BrowserTabMetadata {
  tabs?: TabSummary[]
  tab?: { id: string; url: string; title: string }
  closedTabId?: string
  activeTabId?: string
}

const parameters = z.object({
  action: z.enum(["list", "new", "close", "switch"]).describe("Tab operation: list, new, close, or switch"),
  tabId: z.string().optional().describe("Tab ID to close or switch to"),
  url: z.string().optional().describe("URL to navigate the new tab to (action=new)"),
})

export const BrowserTabTool = Tool.define<typeof parameters, BrowserTabMetadata>("browser_tab", {
  description: "Manage browser tabs: list all tabs, create a new tab, close a tab, or switch the active tab.",
  parameters,
  async execute(params, ctx) {
    await BrowserRuntime.ensure()
    const owner = BrowserOwner.fromToolContext(ctx)
    const session = await BrowserToolHelper.getOrCreateSession(owner)

    switch (params.action) {
      case "list": {
        const tabs: TabSummary[] = session.tabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t === session.activeTab,
        }))
        return {
          title: `Tabs (${tabs.length})`,
          output: JSON.stringify(tabs, null, 2),
          metadata: { tabs },
        }
      }

      case "new": {
        const tab = await session.createTab(params.url)
        return {
          title: "New tab",
          output: `Created tab ${tab.id}${params.url ? ` at ${params.url}` : ""}`,
          metadata: { tab: { id: tab.id, url: tab.url, title: tab.title } },
        }
      }

      case "close": {
        if (!params.tabId) throw new Error("tabId is required for close action")
        const target = session.getTab(params.tabId)
        if (!target) throw new Error(`Tab ${params.tabId} not found`)
        await session.closeTab(params.tabId)
        return {
          title: "Tab closed",
          output: `Closed tab ${params.tabId} (${target.url || "about:blank"})`,
          metadata: { closedTabId: params.tabId },
        }
      }

      case "switch": {
        if (!params.tabId) throw new Error("tabId is required for switch action")
        const target = session.getTab(params.tabId)
        if (!target) throw new Error(`Tab ${params.tabId} not found`)
        session.switchTab(params.tabId)
        return {
          title: "Switched",
          output: `Switched to tab ${params.tabId} (${target.url || "about:blank"})`,
          metadata: { activeTabId: params.tabId },
        }
      }

      default:
        throw new Error(`Unknown action: ${params.action}`)
    }
  },
})
