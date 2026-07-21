import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper, formatBrowserJSON } from "./browser-shared"

const category = z.enum(["accessibility", "semantic", "seo", "best-practices"])

export const BrowserAuditTool = Tool.define("browser_audit", {
  description: "Audit the current document for accessibility, semantic HTML, SEO, and frontend best-practice issues.",
  parameters: z.object({ categories: z.array(category).min(1).max(4).optional() }).strict(),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    const result = await BrowserToolHelper.execute(ctx, { type: "audit", categories: params.categories })
    if (result.type !== "data") throw new Error("Browser audit returned an unexpected result.")
    const formatted = formatBrowserJSON(result.data)
    return {
      title: "Browser page audit",
      output: formatted.output,
      metadata: {
        pageId: page.id,
        categories: params.categories ?? category.options,
        outputTruncated: formatted.truncated,
      },
    }
  },
})
