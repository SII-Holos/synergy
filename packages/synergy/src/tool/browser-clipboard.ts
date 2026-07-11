import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper, truncateBrowserOutput } from "./browser-shared"

const MAX_CLIPBOARD_BYTES = 1024 * 1024

export const BrowserClipboardTool = Tool.define("browser_clipboard", {
  description: "Read, write, or clear page clipboard text through the dedicated browser clipboard capability.",
  parameters: z
    .object({
      action: z.enum(["read", "write", "clear"]),
      text: z.string().max(1_000_000).optional().describe("Required only for write."),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "write" && value.text === undefined) {
        ctx.addIssue({ code: "custom", path: ["text"], message: "text is required for write." })
      }
      if (value.action !== "write" && value.text !== undefined) {
        ctx.addIssue({ code: "custom", path: ["text"], message: "text is valid only for write." })
      }
    }),
  async execute(params, ctx) {
    if (params.text && Buffer.byteLength(params.text, "utf8") > MAX_CLIPBOARD_BYTES) {
      throw new Error("Clipboard text exceeds the 1 MB limit.")
    }
    const page = await BrowserToolHelper.resolvePage(ctx)
    const result = await BrowserToolHelper.execute(ctx, { type: "clipboard", action: params.action, text: params.text })
    if (result.type !== "data") throw new Error("Browser clipboard returned an unexpected result.")
    const data = result.data as { text?: string; byteLength?: number }
    const formatted = truncateBrowserOutput(
      params.action === "read" ? data.text || "(clipboard empty)" : JSON.stringify(data),
    )
    return {
      title: `Browser clipboard: ${params.action}`,
      output: formatted.output,
      metadata: {
        pageId: page.id,
        action: params.action,
        byteLength: data.byteLength ?? Buffer.byteLength(data.text ?? "", "utf8"),
        outputTruncated: formatted.truncated,
      },
    }
  },
})
