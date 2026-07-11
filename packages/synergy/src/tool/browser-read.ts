import z from "zod"
import { BrowserLocatorSchema } from "@ericsanchezok/synergy-browser"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserReadTool = Tool.define("browser_read", {
  description:
    "Read a bounded text, Markdown, or HTML representation of the current page or one uniquely matched element.",
  parameters: z
    .object({
      format: z.enum(["text", "markdown", "html"]).default("text"),
      target: BrowserLocatorSchema.optional(),
      maxChars: z.number().int().min(1).max(200_000).default(20_000),
    })
    .strict(),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    return BrowserToolHelper.withActivity(
      ctx,
      page,
      "reading",
      "browser_read",
      `Reading ${params.format}`,
      async () => {
        const result = await BrowserToolHelper.execute(ctx, { type: "read", ...params })
        if (result.type !== "data") throw new Error("Browser read returned an unexpected result.")
        const data = result.data as { content?: string; truncated?: boolean }
        return {
          title: `Read ${params.format} from ${page.url || page.title || "page"}`,
          output: data.content || "(empty page)",
          metadata: { pageId: page.id, url: page.url, format: params.format, truncated: Boolean(data.truncated) },
        }
      },
    )
  },
})
