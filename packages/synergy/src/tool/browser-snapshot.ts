import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { formatSnapshotText } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { BrowserOwner } from "../browser/owner"

export const BrowserSnapshotTool = Tool.define("browser_snapshot", {
  description:
    "Capture the accessibility tree of the current browser page. Returns a structured text representation of interactive elements with @eN refs that can be used with browser_inspect and other interaction tools. Use this to understand page structure and discover actionable elements.",
  parameters: z.object({
    tabId: z.string().optional().describe("Tab ID. Uses the active tab if omitted."),
    interactiveOnly: z.boolean().default(false).describe("Only include interactive elements with refs. Default false."),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum depth of the accessibility tree to render. Default unlimited."),
  }),
  async execute(params, ctx) {
    await BrowserRuntime.ensure()
    const owner = BrowserOwner.fromToolContext(ctx)
    const helperCtx: BrowserToolHelper.Context = {
      scopeID: owner.scopeID,
      directory: owner.directory,
      sessionID: owner.sessionID,
    }
    const tab = await BrowserToolHelper.getTab(helperCtx, params.tabId)

    const snapshot = await tab.snapshot()
    const text = formatSnapshotText(snapshot.elements, {
      interactiveOnly: params.interactiveOnly,
      maxDepth: params.maxDepth,
    })

    return {
      title: `Snapshot of ${tab.url || tab.title || "page"}`,
      output: text,
      metadata: {
        url: tab.url,
        tabId: tab.id,
        elementsCount: snapshot.elements.length,
        truncated: snapshot.truncated,
      },
    }
  },
})
