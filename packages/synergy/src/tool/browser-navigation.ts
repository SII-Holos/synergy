import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"

export const BrowserNavigationTool = Tool.define("browser_navigation", {
  description:
    "Control browser navigation: go back, forward, reload, stop loading, or read current page URL and title.",
  parameters: z.object({
    action: z.enum(["back", "forward", "reload", "stop", "current"]),
    ignoreCache: z.boolean().optional(),
    tabId: z.string().optional(),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    const kind = params.action === "current" ? "reading" : "acting"
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      kind,
      "browser_navigation",
      `Navigation ${params.action}`,
      async () => {
        switch (params.action) {
          case "back":
            await BrowserToolHelper.executeControl(owner, { type: "history", tabId: tab.id, direction: "back" })
            break
          case "forward":
            await BrowserToolHelper.executeControl(owner, { type: "history", tabId: tab.id, direction: "forward" })
            break
          case "reload":
            await BrowserToolHelper.executeControl(owner, {
              type: "reload",
              tabId: tab.id,
              ignoreCache: params.ignoreCache,
            })
            break
          case "stop":
            await BrowserToolHelper.executeControl(owner, { type: "stop", tabId: tab.id })
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
    )
  },
})
