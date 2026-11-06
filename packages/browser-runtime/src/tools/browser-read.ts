import { z } from "zod"
import { BrowserLocatorSchema } from "@ericsanchezok/synergy-browser-core"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserReadTool = Tool.define("browser_read", {
  description:
    "Read a bounded text, Markdown, or HTML representation of the current page or one uniquely matched element.",
  parameters: z
    .object({
      pageId: z.string().min(1).max(200).describe("Page ID from browser_navigation."),
      format: z.enum(["text", "markdown", "html"]).default("text"),
      target: BrowserLocatorSchema.optional(),
      maxChars: z.number().int().min(1).max(200_000).default(20_000),
    })
    .strict(),
  async execute({ pageId, ...params }, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx, pageId)

    const result = await BrowserToolHelper.execute(ctx, pageId, { type: "read", ...params })
    if (result.type !== "data") throw new Error("Browser read returned an unexpected result.")
    const data = result.data as { content?: string; truncated?: boolean }
    return {
      title: `Read ${params.format} from ${page.url || page.title || "page"}`,
      output: [result.userChanges, data.content || "(empty page)"].filter(Boolean).join("\n\n"),
      metadata: { pageId: page.id, url: page.url, format: params.format, truncated: Boolean(data.truncated) },
    }
  },
})
