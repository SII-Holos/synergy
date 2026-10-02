import { z } from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { BrowserToolHelper, formatBrowserJSON, browserAgentRecord } from "./browser-shared"

export const BrowserConsoleTool = Tool.define("browser_console", {
  description:
    "Read or clear redacted Chromium console logs and page errors, including source and stack information. For debugging, clear immediately before reproducing, then list entries and get a specific entryId for full details.",
  parameters: z
    .object({
      pageId: z.string().min(1).max(200).describe("Page ID from browser_navigation."),
      action: z.enum(["list", "get", "clear"]).default("list"),
      entryId: z.string().max(20_000).optional().describe("entryId from list; required only for get."),
      level: z.string().max(1_000).optional().describe("Optional console level filter for list."),
      filter: z.string().max(20_000).optional().describe("Optional case-insensitive text filter for list."),
      page: z.number().int().min(0).optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "get" && !value.entryId)
        ctx.addIssue({ code: "custom", path: ["entryId"], message: "entryId is required for get." })
      if (value.action !== "get" && value.entryId !== undefined)
        ctx.addIssue({ code: "custom", path: ["entryId"], message: "entryId is valid only for get." })
      if (value.action !== "list") {
        for (const field of ["level", "filter", "page", "pageSize"] as const) {
          if (value[field] !== undefined)
            ctx.addIssue({ code: "custom", path: [field], message: `${field} is valid only for list.` })
        }
      }
    }),
  async execute({ pageId, entryId, ...params }, ctx) {
    const browserPage = await BrowserToolHelper.resolvePage(ctx, pageId)
    return BrowserToolHelper.withActivity(
      ctx,
      browserPage,
      "reading",
      "browser_console",
      `${params.action} console`,
      async () => {
        const result = await BrowserToolHelper.execute(ctx, pageId, { type: "console", ...params, id: entryId })
        if (result.type !== "data") throw new Error("Browser console returned an unexpected result.")
        const formatted = formatBrowserJSON(browserAgentRecord(result.data, "entryId", "entries"))
        return {
          title: `Browser console: ${params.action}`,
          output: formatted.output,
          metadata: { pageId: browserPage.id, action: params.action, outputTruncated: formatted.truncated },
        }
      },
    )
  },
})
