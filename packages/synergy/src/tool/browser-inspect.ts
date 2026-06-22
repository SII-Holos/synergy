import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserInspectTool = Tool.define("browser_inspect", {
  description:
    "Inspect an element on the current browser page by accessibility ref (e.g. @e12). Returns the element's tag name, attributes, bounding box, and text content. Use refs from browser_snapshot output to target specific elements.",
  parameters: z.object({
    ref: z.string().describe("Accessibility ref from a snapshot (e.g. @e12)."),
    tabId: z.string().optional().describe("Tab ID. Uses the active tab if omitted."),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)

    if (!params.ref.startsWith("@e")) {
      throw new Error(`Invalid ref: ${params.ref}. Expected format: @eN (e.g. @e12)`)
    }

    const cdp = tab.cdp
    if (!cdp) throw new Error("Browser CDP connection not available")

    // Resolve ref to backendNodeId + bounds
    const resolved = await tab.resolveRef(params.ref)
    if (!resolved) throw new Error(`Element not found for ref: ${params.ref}`)

    const { backendNodeId, x, y, width, height } = resolved

    // Get element details via CDP DOM.describeNode
    const describeResult = (await cdp.send("DOM.describeNode", { backendNodeId })) as {
      node: {
        nodeName: string
        localName: string
        nodeValue: string
        attributes?: string[]
      }
    }
    const node = describeResult.node
    const tag = node.localName ?? node.nodeName?.toLowerCase() ?? "unknown"

    // Build attributes map from flat [key, value, key, value, ...] array
    const attributes: Record<string, string> = {}
    const attrArray = node.attributes ?? []
    for (let i = 0; i < attrArray.length; i += 2) {
      attributes[attrArray[i]] = attrArray[i + 1] ?? ""
    }

    // Get text content via Runtime.evaluate on the resolved node
    let text = ""
    try {
      const resolveResult = (await cdp.send("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId: string }
      }
      const objectId = resolveResult.object?.objectId
      if (objectId) {
        const textResult = (await cdp.send("Runtime.callFunctionOn", {
          functionDeclaration: `function() { return this.textContent?.trim()?.slice(0, 2000) ?? "" }`,
          objectId,
          returnByValue: true,
        })) as { result?: { value?: string } }
        text = textResult.result?.value ?? ""
      }
    } catch {
      /* ignore text extraction failures */
    }

    const properties: string[] = [`tag: <${tag}>`]
    if (Object.keys(attributes).length > 0) {
      properties.push(`attributes: ${JSON.stringify(attributes)}`)
    }
    if (width > 0 || height > 0) {
      properties.push(
        `bounds: { x: ${Math.round(x)}, y: ${Math.round(y)}, width: ${Math.round(width)}, height: ${Math.round(height)} }`,
      )
    }
    if (text) {
      properties.push(`text: "${text}"`)
    }

    return {
      title: `Inspected ${params.ref}`,
      output: properties.join("\n"),
      metadata: {
        tabId: tab.id,
        ref: params.ref,
        tag,
        attributes,
        bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
        text,
      },
    }
  },
})
