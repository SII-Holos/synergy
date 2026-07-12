import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper, formatBrowserJSON } from "./browser-shared"

export const BrowserNetworkTool = Tool.define("browser_network", {
  description:
    "Read or clear Chromium network requests, responses, failures, redirects, timing, and resource types. For debugging, clear immediately before reproducing, list failed/status-filtered records, then get a specific id. Sensitive headers and payload data are redacted by default.",
  parameters: z
    .object({
      action: z.enum(["list", "get", "clear"]).default("list"),
      id: z.string().max(20_000).optional().describe("Required only for get."),
      resourceTypes: z.array(z.string().max(1_000)).max(100).optional(),
      status: z.number().int().optional(),
      page: z.number().int().min(0).optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
      includeBody: z.boolean().optional(),
      includeSensitive: z.boolean().optional(),
      maxBodyBytes: z.number().int().min(1).max(200_000).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "get" && !value.id)
        ctx.addIssue({ code: "custom", path: ["id"], message: "id is required for get." })
      if (value.action !== "get" && value.id !== undefined)
        ctx.addIssue({ code: "custom", path: ["id"], message: "id is valid only for get." })
      if (value.action !== "get" && value.includeBody)
        ctx.addIssue({ code: "custom", path: ["includeBody"], message: "includeBody is valid only for get." })
      if (value.action !== "list") {
        for (const field of ["resourceTypes", "status", "page", "pageSize"] as const) {
          if (value[field] !== undefined)
            ctx.addIssue({ code: "custom", path: [field], message: `${field} is valid only for list.` })
        }
      }
      if (value.action !== "get" && value.maxBodyBytes !== undefined)
        ctx.addIssue({ code: "custom", path: ["maxBodyBytes"], message: "maxBodyBytes is valid only for get." })
      if (value.action === "clear" && value.includeSensitive !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["includeSensitive"],
          message: "includeSensitive is valid only for list or get.",
        })
    }),
  async execute(params, ctx) {
    const browserPage = await BrowserToolHelper.resolvePage(ctx)
    return BrowserToolHelper.withActivity(
      ctx,
      browserPage,
      "reading",
      "browser_network",
      `${params.action} network`,
      async () => {
        const result = await BrowserToolHelper.execute(ctx, { type: "network", ...params })
        if (result.type !== "data") throw new Error("Browser network returned an unexpected result.")
        const formatted = formatBrowserJSON(result.data)
        return {
          title: `Browser network: ${params.action}`,
          output: formatted.output,
          metadata: { pageId: browserPage.id, action: params.action, outputTruncated: formatted.truncated },
        }
      },
    )
  },
})
