import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"
import type { BrowserTab } from "../browser/tab"

export const BrowserNavigateTool = Tool.define("browser_navigate", {
  description:
    "Navigate the session browser page to a URL and return a compact page title/URL summary. Creates the page first when none exists. Use browser_snapshot afterward when page structure or element refs are needed. Only allowed URLs can be navigated.",
  parameters: z.object({
    url: z.string().describe("URL to navigate to"),
    pageId: z.string().optional().describe("Page ID. Uses the session page if omitted."),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    let page: BrowserTab | undefined

    try {
      const resolved = await BrowserToolHelper.getOrCreatePage(owner, params.pageId)
      const session = resolved.session
      page = resolved.page
      await BrowserToolHelper.markActivity(ctx, page, "acting", "browser_navigate", `Navigating to ${params.url}`)
      const result = await BrowserToolHelper.navigateWithPolicyApproval(ctx, page, params.url, owner)

      // Notify frontend before snapshot — snapshot may fail if Playwright
      // is unavailable but navigation is already done and must be surfaced.
      await session.save()
      await session.notifyPageNavigated(page)

      return {
        title: `Navigated to ${result.url}`,
        output: `Page title: ${result.title}\nURL: ${result.url}`,
        metadata: {
          url: result.url,
          title: result.title,
          pageId: page.id,
          activityKind: "acting",
        },
      }
    } finally {
      if (page) await BrowserToolHelper.markIdle(ctx, page, "browser_navigate")
    }
  },
})
