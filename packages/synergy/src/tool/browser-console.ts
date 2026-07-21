import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper, formatBrowserJSON } from "./browser-shared"

export const BrowserConsoleTool = Tool.define("browser_console", {
  description:
    "Read or clear redacted Chromium console logs and page errors, including source and stack information. For debugging, clear immediately before reproducing, then list entries and get a specific id for full details.",
  parameters: z
    .object({
      action: z.enum(["list", "get", "clear"]).default("list"),
      id: z.string().max(20_000).optional().describe("Required only for get."),
      level: z.string().max(1_000).optional().describe("Optional console level filter for list."),
      filter: z.string().max(20_000).optional().describe("Optional case-insensitive text filter for list."),
      page: z.number().int().min(0).optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "get" && !value.id)
        ctx.addIssue({ code: "custom", path: ["id"], message: "id is required for get." })
      if (value.action !== "get" && value.id !== undefined)
        ctx.addIssue({ code: "custom", path: ["id"], message: "id is valid only for get." })
      if (value.action !== "list") {
        for (const field of ["level", "filter", "page", "pageSize"] as const) {
          if (value[field] !== undefined)
            ctx.addIssue({ code: "custom", path: [field], message: `${field} is valid only for list.` })
        }
      }
    }),
  async execute(params, ctx) {
    const browserPage = await BrowserToolHelper.resolvePage(ctx)
    return BrowserToolHelper.withActivity(
      ctx,
      browserPage,
      "reading",
      "browser_console",
      `${params.action} console`,
      async () => {
        const result = await BrowserToolHelper.execute(ctx, { type: "console", ...params })
        if (result.type !== "data") throw new Error("Browser console returned an unexpected result.")
        const formatted = formatBrowserJSON(result.data)
        return {
          title: `Browser console: ${params.action}`,
          output: formatted.output,
          metadata: { pageId: browserPage.id, action: params.action, outputTruncated: formatted.truncated },
        }
      },
    )
  },
})
