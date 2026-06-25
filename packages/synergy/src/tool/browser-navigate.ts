import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"
import type { BrowserTab } from "../browser/tab"

export const BrowserNavigateTool = Tool.define("browser_navigate", {
  description:
    "Navigate a browser tab to a URL and return a compact page title/URL summary. Creates a tab first when no active tab exists. Use browser_snapshot afterward when page structure or element refs are needed. Only allowed URLs can be navigated.",
  parameters: z.object({
    url: z.string().describe("URL to navigate to"),
    tabId: z.string().optional().describe("Tab ID. Uses the active tab if omitted."),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    let tab: BrowserTab | undefined

    try {
      const resolved = await BrowserToolHelper.getOrCreateTab(owner, params.tabId)
      const session = resolved.session
      tab = resolved.tab
      await BrowserToolHelper.markActivity(ctx, tab, "acting", "browser_navigate", `Navigating to ${params.url}`)
      const result = await BrowserToolHelper.navigateWithPolicyApproval(ctx, tab, params.url, owner)

      // Notify frontend before snapshot — snapshot may fail if Playwright
      // is unavailable but navigation is already done and must be surfaced.
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
    } finally {
      if (tab) await BrowserToolHelper.markIdle(ctx, tab, "browser_navigate")
    }
  },
})
