import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { formatSnapshotText } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"

export const BrowserSnapshotTool = Tool.define("browser_snapshot", {
  description:
    "Capture the accessibility tree of the current browser page. Returns a structured text representation of interactive elements with @eN refs that can be used with browser_inspect and other interaction tools. Use this to understand page structure and discover actionable elements.",
  parameters: z.object({
    pageId: z.string().optional().describe("Page ID. Uses the session page if omitted."),
    interactiveOnly: z.boolean().default(false).describe("Only include interactive elements with refs. Default false."),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum depth of the accessibility tree to render. Default unlimited."),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.getPage(owner, params.pageId)
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      "reading",
      "browser_snapshot",
      "Reading page structure",
      async () => {
        const result = await BrowserToolHelper.executeControl(owner, { type: "snapshot", pageId: tab.id })
        if (result.type !== "snapshot") throw new Error("Browser snapshot command returned an unexpected result")
        const text = formatSnapshotText(result.elements, {
          interactiveOnly: params.interactiveOnly,
          maxDepth: params.maxDepth,
        })

        return {
          title: `Snapshot of ${tab.url || tab.title || "page"}`,
          output: text,
          metadata: {
            url: tab.url,
            pageId: tab.id,
            elementsCount: result.elements.length,
            truncated: result.truncated,
          },
        }
      },
    )
  },
})
