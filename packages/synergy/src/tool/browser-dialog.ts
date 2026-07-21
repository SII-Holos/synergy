import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper, formatBrowserJSON } from "./browser-shared"

export const BrowserDialogTool = Tool.define("browser_dialog", {
  description: "Inspect, accept, or dismiss the currently open JavaScript dialog, optionally supplying prompt text.",
  parameters: z
    .object({
      action: z.enum(["status", "accept", "dismiss"]),
      promptText: z.string().max(1_000_000).optional().describe("Valid only for accept."),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action !== "accept" && value.promptText !== undefined) {
        ctx.addIssue({ code: "custom", path: ["promptText"], message: "promptText is valid only for accept." })
      }
    }),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    const result = await BrowserToolHelper.execute(ctx, { type: "dialog", ...params })
    if (result.type !== "data") throw new Error("Browser dialog returned an unexpected result.")
    const formatted = formatBrowserJSON(result.data)
    return {
      title: `Browser dialog: ${params.action}`,
      output: formatted.output,
      metadata: { pageId: page.id, action: params.action, outputTruncated: formatted.truncated },
    }
  },
})
