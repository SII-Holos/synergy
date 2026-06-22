import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserPageRead } from "../browser/page-read"
import { LocatorInputSchema } from "../browser/locator"

export const BrowserReadTool = Tool.define("browser_read", {
  description:
    "Read page content from the browser. Supports accessibility tree snapshot, full DOM view, page text extraction, element attributes, and computed style for a specific element.",
  parameters: z.object({
    type: z
      .enum(["accessibility", "dom", "text", "attributes", "style"])
      .describe(
        "What to read: accessibility (interactive element tree), dom (full HTML), text (visible page text), attributes (element attributes), style (computed styles)",
      ),
    locator: LocatorInputSchema.optional().describe(
      "Locator for attributes/style type. Uses a snapshot ref like @e4 or CSS selector.",
    ),
    maxBytes: z.number().int().default(64000).describe("Maximum output size in bytes."),
    tabId: z.string().optional().describe("Tab ID. Uses active tab if omitted."),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)

    switch (params.type) {
      case "accessibility": {
        const snap = await tab.snapshot()
        const text = BrowserPageRead.truncateHTML(JSON.stringify(snap.elements), params.maxBytes)
        return {
          title: `Accessibility snapshot of ${tab.url || "page"}`,
          output: text,
          metadata: { tabId: tab.id, elementsCount: snap.elements.length, truncated: snap.truncated },
        }
      }
      case "text": {
        const result = await tab.evaluate("document.body ? document.body.innerText || '' : ''")
        const raw = typeof result === "string" ? result : ""
        const text = BrowserPageRead.truncateHTML(raw, params.maxBytes)
        return {
          title: `Page text of ${tab.url || "page"}`,
          output: text,
          metadata: { tabId: tab.id },
        }
      }
      case "attributes": {
        if (!params.locator) throw new Error("locator is required for attributes type")
        const resolved = await tab.resolveRef(typeof params.locator.value === "string" ? params.locator.value : "@e1")
        if (!resolved) throw new Error("Element not found")
        return {
          title: `Element attributes`,
          output: `backendNodeId: ${resolved.backendNodeId}\nbounds: ${Math.round(resolved.x)},${Math.round(resolved.y)} ${Math.round(resolved.width)}×${Math.round(resolved.height)}`,
          metadata: { tabId: tab.id },
        }
      }
      case "style": {
        if (!params.locator) throw new Error("locator is required for style type")
        const resolved = await tab.resolveRef(typeof params.locator.value === "string" ? params.locator.value : "@e1")
        if (!resolved) throw new Error("Element not found")
        const boxInfo = `x:${Math.round(resolved.x)} y:${Math.round(resolved.y)} w:${Math.round(resolved.width)} h:${Math.round(resolved.height)}`
        return {
          title: `Element bounds`,
          output: boxInfo,
          metadata: { tabId: tab.id },
        }
      }
      case "dom": {
        const snap = await tab.snapshot()
        const text = BrowserPageRead.truncateHTML(JSON.stringify(snap.elements), params.maxBytes)
        return {
          title: `DOM snapshot of ${tab.url || "page"}`,
          output: text,
          metadata: { tabId: tab.id },
        }
      }
      default:
        throw new Error(`Unknown read type: ${params.type}`)
    }
  },
})
