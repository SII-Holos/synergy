import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserClipboard } from "../browser/clipboard"

const parameters = z.object({
  action: z.enum(["read", "write"]).describe("Whether to read from or write to the clipboard."),
  text: z.string().optional().describe("Text to write to the clipboard. Required when action is 'write'."),
  tabId: z.string().optional().describe("Tab ID. Uses the active tab if omitted."),
})

interface BrowserClipboardMetadata {
  action: string
  tabId: string
  hasText?: boolean
  byteLength?: number
  ok?: boolean
}

export const BrowserClipboardTool = Tool.define<typeof parameters, BrowserClipboardMetadata>("browser_clipboard", {
  description:
    "Read or write text from the browser clipboard via navigator.clipboard. Read returns the current clipboard text; write copies the provided text to the clipboard.",
  parameters,
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)

    if (params.action === "read") {
      const raw = (await tab.evaluate(BrowserClipboard.buildReadClipboardExpr())) as string | null
      const text = raw !== null && raw !== undefined ? BrowserClipboard.sanitizeClipboardText(raw) : null
      return {
        title: `Clipboard read (tab: ${tab.id})`,
        output: text ?? "(clipboard empty or permission denied)",
        metadata: { action: "read", tabId: tab.id, hasText: text !== null },
      }
    }

    // write
    if (!params.text) throw new Error("text is required for clipboard write")
    const result = (await tab.evaluate(BrowserClipboard.buildWriteClipboardExpr(params.text))) as boolean
    const ok = result === true
    return {
      title: `Clipboard write${ok ? "" : " failed"} (tab: ${tab.id})`,
      output: ok
        ? `Copied ${Buffer.byteLength(params.text, "utf-8")} bytes to clipboard.`
        : "Clipboard write failed — permission may be denied.",
      metadata: { action: "write", tabId: tab.id, ok, byteLength: Buffer.byteLength(params.text, "utf-8") },
    }
  },
})
