import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserClipboard } from "../browser/clipboard"

const parameters = z.object({
  action: z.enum(["read", "write"]).describe("Whether to read from or write to the clipboard."),
  text: z.string().optional().describe("Text to write to the clipboard. Required when action is 'write'."),
  pageId: z.string().optional().describe("Page ID. Uses the session page if omitted."),
})

interface BrowserClipboardMetadata {
  action: string
  pageId: string
  hasText?: boolean
  byteLength?: number
  ok?: boolean
}

export const BrowserClipboardTool = Tool.define<typeof parameters, BrowserClipboardMetadata>("browser_clipboard", {
  description:
    "Read or write text from the browser clipboard via navigator.clipboard. Read returns the current clipboard text; write copies the provided text to the clipboard.",
  parameters,
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolvePage(ctx, params.pageId)
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
          if (page) {
            const result = await BrowserClipboard.readViaPage(page)
            return {
              title: `Clipboard read (tab: ${tab.id})`,
              output: result.text ?? "(clipboard empty or permission denied)",
              metadata: { action: "read", pageId: tab.id, hasText: result.ok },
            }
          }
          // Workspace fallback: read via browser_eval
          try {
            const text = await tab.evaluate("navigator.clipboard.readText()")
            return {
              title: `Clipboard read (tab: ${tab.id})`,
              output: String(text ?? ""),
              metadata: { action: "read", pageId: tab.id, hasText: typeof text === "string" && text.length > 0 },
            }
          } catch {
            return {
              title: `Clipboard read failed (tab: ${tab.id})`,
              output: "(clipboard read failed — permission may be denied)",
              metadata: { action: "read", pageId: tab.id, hasText: false },
            }
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
              pageId: tab.id,
              ok: result.ok,
              byteLength: Buffer.byteLength(params.text, "utf-8"),
            },
          }
        }
        // Workspace fallback: write via browser_eval
        try {
          await tab.evaluate(`navigator.clipboard.writeText(${JSON.stringify(params.text)})`)
          return {
            title: `Clipboard write (tab: ${tab.id})`,
            output: `Copied ${Buffer.byteLength(params.text, "utf-8")} bytes to clipboard.`,
            metadata: {
              action: "write",
              pageId: tab.id,
              ok: true,
              byteLength: Buffer.byteLength(params.text, "utf-8"),
            },
          }
        } catch {
          return {
            title: `Clipboard write failed (tab: ${tab.id})`,
            output: "(clipboard write failed — permission may be denied)",
            metadata: { action: "write", pageId: tab.id, ok: false, byteLength: 0 },
          }
        }
      },
    )
  },
})
