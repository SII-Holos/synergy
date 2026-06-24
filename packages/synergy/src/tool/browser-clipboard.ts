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
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      params.action === "read" ? "reading" : "acting",
      "browser_clipboard",
      `${params.action} clipboard`,
      async () => {
        // Route clipboard operations through Playwright context.grantPermissions + page.evaluate
        const page = tab.page

        if (params.action === "read") {
          // Uses Playwright grantPermissions + page.evaluate for clipboard read
          if (page) {
            const result = await BrowserClipboard.readViaPage(page)
            return {
              title: `Clipboard read (tab: ${tab.id})`,
              output: result.text ?? "(clipboard empty or permission denied)",
              metadata: { action: "read", tabId: tab.id, hasText: result.ok },
            }
          }
          return {
            title: `Clipboard read (tab: ${tab.id})`,
            output: "(no page available)",
            metadata: { action: "read", tabId: tab.id, hasText: false },
          }
        }

        // write
        if (!params.text) throw new Error("text is required for clipboard write")
        if (page) {
          const result = await BrowserClipboard.writeViaPage(page, params.text)
          return {
            title: `Clipboard write${result.ok ? "" : " failed"} (tab: ${tab.id})`,
            output: result.ok
              ? `Copied ${Buffer.byteLength(params.text, "utf-8")} bytes to clipboard.`
              : "Clipboard write failed — permission may be denied.",
            metadata: {
              action: "write",
              tabId: tab.id,
              ok: result.ok,
              byteLength: Buffer.byteLength(params.text, "utf-8"),
            },
          }
        }
        return {
          title: `Clipboard write failed (tab: ${tab.id})`,
          output: "(no page available)",
          metadata: { action: "write", tabId: tab.id, ok: false, byteLength: 0 },
        }
      },
    )
  },
})
