import z from "zod"
import { BrowserLocatorSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "./tool"
import { BrowserToolHelper, formatBrowserJSON } from "./browser-shared"

export const BrowserInspectTool = Tool.define("browser_inspect", {
  description:
    "Inspect one uniquely matched element, including attributes, HTML, computed styles, box model, accessibility properties, and registered listeners.",
  parameters: z
    .object({
      target: BrowserLocatorSchema,
      computedStyles: z.array(z.string().min(1).max(1_000)).max(100).optional(),
    })
    .strict(),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    return BrowserToolHelper.withActivity(ctx, page, "reading", "browser_inspect", "Inspecting element", async () => {
      const result = await BrowserToolHelper.execute(ctx, { type: "inspect", ...params })
      if (result.type !== "data") throw new Error("Browser inspect returned an unexpected result.")
      const formatted = formatBrowserJSON(result.data)
      return {
        title: "Browser element inspection",
        output: formatted.output,
        metadata: { pageId: page.id, target: params.target, outputTruncated: formatted.truncated },
      }
    })
  },
})
