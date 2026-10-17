import { z } from "zod"
import { BrowserLocatorSchema } from "@ericsanchezok/synergy-browser-core"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { BrowserToolHelper, formatBrowserJSON } from "./browser-shared"

export const BrowserInspectTool = Tool.define("browser_inspect", {
  description:
    "Inspect one uniquely matched element, including attributes, HTML, computed styles, box model, accessibility properties, and registered listeners.",
  parameters: z
    .object({
      pageId: z.string().min(1).max(200).describe("Page ID from browser_navigation."),
      target: BrowserLocatorSchema,
      computedStyles: z.array(z.string().min(1).max(1_000)).max(100).optional(),
    })
    .strict(),
  async execute({ pageId, ...params }, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx, pageId)

    const result = await BrowserToolHelper.execute(ctx, pageId, { type: "inspect", ...params })
    if (result.type !== "data") throw new Error("Browser inspect returned an unexpected result.")
    const formatted = formatBrowserJSON(result.data)
    return {
      title: "Browser element inspection",
      output: [result.userChanges, formatted.output].filter(Boolean).join("\n\n"),
      metadata: { pageId: page.id, target: params.target, outputTruncated: formatted.truncated },
    }
  },
})
