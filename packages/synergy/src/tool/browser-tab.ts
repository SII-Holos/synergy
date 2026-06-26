import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"

interface TabSummary {
  id: string
  url: string
  title: string
  active: boolean
  pinned: boolean
  kept: boolean
  lastActiveAt: number | null
}

interface BrowserTabMetadata {
  tabs?: TabSummary[]
  tab?: { id: string; url: string; title: string }
  closedTabId?: string
  activeTabId?: string
}

const parameters = z.object({
  action: z
    .enum(["list", "current", "new", "close", "closeOthers", "switch", "pin", "unpin", "keep", "discard"])
    .describe("Tab operation: list, current, new, close, closeOthers, switch, pin, unpin, keep, or discard"),
  tabId: z.string().optional().describe("Tab ID to operate on"),
  url: z.string().optional().describe("URL to navigate the new tab to (action=new)"),
})

export const BrowserTabTool = Tool.define<typeof parameters, BrowserTabMetadata>("browser_tab", {
  description: "Manage browser tabs: list all tabs, create a new tab, close a tab, or switch the active tab.",
  parameters,
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const session = await BrowserToolHelper.getOrCreateSession(owner)
    const activityTab = session.activeTab
    if (activityTab) {
      await BrowserToolHelper.markActivity(
        ctx,
        activityTab,
        ["list", "current"].includes(params.action) ? "reading" : "acting",
        "browser_tab",
        `Tab ${params.action}`,
      )
    }
    try {
      switch (params.action) {
        case "list": {
          const tabs: TabSummary[] = session.tabs.map((t) => ({
            id: t.id,
            url: t.url,
            title: t.title,
            active: t === session.activeTab,
            pinned: t.pinned,
            kept: t.kept,
            lastActiveAt: t.lastActiveAt,
          }))
          return {
            title: `Tabs (${tabs.length})`,
            output: JSON.stringify(tabs, null, 2),
            metadata: { tabs },
          }
        }

        case "current": {
          const active = session.activeTab
          if (!active) throw new Error("No active tab")
          return {
            title: `Current tab`,
            output: JSON.stringify({ id: active.id, url: active.url, title: active.title }),
            metadata: {},
          }
        }

        case "new": {
          const result = await BrowserToolHelper.executeControl(owner, { type: "createTab" })
          if (result.type !== "tab") throw new Error("Browser create tab command returned an unexpected result")
          const tab = session.getTab(result.tab.id)
          if (!tab) throw new Error(`Tab ${result.tab.id} not found after creation`)
          if (params.url) {
            await BrowserToolHelper.markActivity(ctx, tab, "acting", "browser_tab", `Opening ${params.url}`)
            await BrowserToolHelper.navigateWithPolicyApproval(ctx, tab, params.url, owner)
            await session.notifyTabNavigated(tab)
          }
          await session.save()
          return {
            title: "New tab",
            output: `Created tab ${tab.id}${tab.url ? ` at ${tab.url}` : ""}`,
            metadata: { tab: { id: tab.id, url: tab.url, title: tab.title }, activeTabId: tab.id },
          }
        }

        case "close": {
          if (!params.tabId) throw new Error("tabId is required for close action")
          const target = session.getTab(params.tabId)
          if (!target) throw new Error(`Tab ${params.tabId} not found`)
          await BrowserToolHelper.executeControl(owner, { type: "closeTab", tabId: params.tabId })
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
          await BrowserToolHelper.executeControl(owner, { type: "switchTab", tabId: params.tabId })
          return {
            title: "Switched",
            output: `Switched to tab ${params.tabId} (${target.url || "about:blank"})`,
            metadata: { activeTabId: params.tabId },
          }
        }

        case "closeOthers": {
          if (!params.tabId) throw new Error("tabId is required for closeOthers action")
          const target = session.getTab(params.tabId)
          if (!target) throw new Error(`Tab ${params.tabId} not found`)
          await session.closeOthers(params.tabId)
          return {
            title: "Closed other tabs",
            output: `Closed all tabs except ${params.tabId} (and any pinned/kept tabs)`,
            metadata: {},
          }
        }

        case "pin": {
          if (!params.tabId) throw new Error("tabId is required for pin action")
          const target = session.getTab(params.tabId)
          if (!target) throw new Error(`Tab ${params.tabId} not found`)
          target.pinned = true
          await session.save()
          return {
            title: "Tab pinned",
            output: `Pinned tab ${params.tabId}`,
            metadata: {},
          }
        }

        case "unpin": {
          if (!params.tabId) throw new Error("tabId is required for unpin action")
          const target = session.getTab(params.tabId)
          if (!target) throw new Error(`Tab ${params.tabId} not found`)
          target.pinned = false
          await session.save()
          return {
            title: "Tab unpinned",
            output: `Unpinned tab ${params.tabId}`,
            metadata: {},
          }
        }

        case "keep": {
          if (!params.tabId) throw new Error("tabId is required for keep action")
          const target = session.getTab(params.tabId)
          if (!target) throw new Error(`Tab ${params.tabId} not found`)
          target.kept = true
          await session.save()
          return {
            title: "Tab kept",
            output: `Marked tab ${params.tabId} as kept`,
            metadata: {},
          }
        }

        case "discard": {
          if (!params.tabId) throw new Error("tabId is required for discard action")
          const target = session.getTab(params.tabId)
          if (!target) throw new Error(`Tab ${params.tabId} not found`)
          target.kept = false
          target.pinned = false
          await session.save()
          return {
            title: "Tab discarded",
            output: `Discarded tab ${params.tabId}`,
            metadata: {},
          }
        }

        default:
          throw new Error(`Unknown action: ${(params as { action: string }).action}`)
      }
    } finally {
      const tab = session.activeTab ?? activityTab
      if (tab) await BrowserToolHelper.markIdle(ctx, tab, "browser_tab")
    }
  },
})
