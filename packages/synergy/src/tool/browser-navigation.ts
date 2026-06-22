import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserNavigationTool = Tool.define("browser_navigation", {
  description:
    "Control browser navigation: go back, forward, reload, stop loading, or read current page URL and title.",
  parameters: z.object({
    action: z.enum(["back", "forward", "reload", "stop", "current"]),
    ignoreCache: z.boolean().optional(),
    tabId: z.string().optional(),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)

    switch (params.action) {
      case "back":
        await tab.goBack()
        break
      case "forward":
        await tab.goForward()
        break
      case "reload":
        await tab.reload(params.ignoreCache)
        break
      case "stop":
        await tab.stop()
        break
    }

    const url = tab.url || "about:blank"
    const title = tab.title || ""
    return {
      title: params.action === "current" ? "Current page" : `Navigation: ${params.action}`,
      output: `URL: ${url}\nTitle: ${title}`,
      metadata: { url, title, tabId: tab.id },
    }
  },
})
