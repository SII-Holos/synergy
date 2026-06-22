import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { formatSnapshotText } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { BrowserOwner } from "../browser/owner"

export const BrowserNavigateTool = Tool.define("browser_navigate", {
  description:
    "Navigate a browser tab to a URL. Automatically captures a page snapshot (accessibility tree) after navigation and returns the page title and structured content. Only allowed URLs can be navigated.",
  parameters: z.object({
    url: z.string().describe("URL to navigate to"),
    tabId: z.string().optional().describe("Tab ID. Uses the active tab if omitted."),
  }),
  async execute(params, ctx) {
    await BrowserRuntime.ensure()
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.getTab(owner, params.tabId)

    const result = await tab.navigate(params.url)
    const snapshot = await tab.snapshot()
    const text = formatSnapshotText(snapshot.elements)

    return {
      title: `Navigated to ${result.url}`,
      output: `Page title: ${result.title}\n\n${text}`,
      metadata: {
        url: result.url,
        tabId: tab.id,
        elementsCount: snapshot.elements.length,
        truncated: snapshot.truncated,
      },
    }
  },
})
