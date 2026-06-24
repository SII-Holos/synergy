import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { BrowserOwner } from "../browser/owner"
import { BlockedURLNavigationError } from "../browser/tab"

export const BrowserNavigateTool = Tool.define("browser_navigate", {
  description:
    "Navigate a browser tab to a URL and return a compact page title/URL summary. Use browser_snapshot afterward when page structure or element refs are needed. Only allowed URLs can be navigated.",
  parameters: z.object({
    url: z.string().describe("URL to navigate to"),
    tabId: z.string().optional().describe("Tab ID. Uses the active tab if omitted."),
  }),
  async execute(params, ctx) {
    await BrowserRuntime.ensure()
    const owner = BrowserOwner.fromToolContext(ctx)

    try {
      const tab = await BrowserToolHelper.getTab(owner, params.tabId)
      await BrowserToolHelper.markActivity(ctx, tab, "acting", "browser_navigate", `Navigating to ${params.url}`)
      const result = await tab.navigate(params.url)

      // Notify frontend before snapshot — snapshot may fail if Playwright
      // is unavailable but navigation is already done and must be surfaced.
      const session = await BrowserToolHelper.getOrCreateSession(owner)
      await session.save()
      await session.notifyTabNavigated(tab)

      return {
        title: `Navigated to ${result.url}`,
        output: `Page title: ${result.title}\nURL: ${result.url}`,
        metadata: {
          url: result.url,
          title: result.title,
          tabId: tab.id,
          activityKind: "acting",
        },
      }
    } catch (err) {
      if (err instanceof BlockedURLNavigationError) {
        await ctx.ask({
          permission: "network_request",
          patterns: [err.url],
          metadata: {
            nonBypassable: false,
            capability: "network_request",
            reason: err.message,
          },
        })
        // Retry with policy override; notify frontend before snapshot.
        const tab = await BrowserToolHelper.getTab(owner, params.tabId)
        await BrowserToolHelper.markActivity(ctx, tab, "acting", "browser_navigate", `Navigating to ${err.url}`)
        const result = await tab.navigateWithOverride(err.url)

        const session = await BrowserToolHelper.getOrCreateSession(owner)
        await session.save()
        await session.notifyTabNavigated(tab)

        return {
          title: `Navigated to ${result.url}`,
          output: `Page title: ${result.title}\nURL: ${result.url}`,
          metadata: {
            url: result.url,
            title: result.title,
            tabId: tab.id,
            activityKind: "acting",
          },
        }
      }
      throw err
    } finally {
      try {
        const tab = await BrowserToolHelper.getTab(owner, params.tabId)
        await BrowserToolHelper.markIdle(ctx, tab, "browser_navigate")
      } catch {
        /* ignore idle notification failures */
      }
    }
  },
})
