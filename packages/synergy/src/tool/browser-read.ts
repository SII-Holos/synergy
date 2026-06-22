import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper, formatSnapshotText } from "./browser-shared"
import { BrowserLocator } from "../browser/locator"
import { truncateHTML, domSnapshot, pageText, elementAttributes, computedStyle } from "../browser/page-read"
import type { BrowserTab } from "../browser/tab"

const parameters = z.object({
  type: z.enum(["accessibility", "dom", "text", "attributes", "style"]).describe("Type of page content to read."),
  locator: BrowserLocator.LocatorInputSchema.optional().describe(
    "Element locator. Required for attributes/style; optional for accessibility/dom/text (limits reading to a specific element).",
  ),
  maxBytes: z.number().int().min(1).default(64000).describe("Maximum output size in bytes."),
  tabId: z.string().optional().describe("Tab ID. Uses the active tab if omitted."),
})

interface BrowserReadMetadata {
  url: string
  tabId: string
  type: string
  truncated: boolean
  elementsCount?: number
  byteLength?: number
  attributeCount?: number
  propertyCount?: number
}

export const BrowserReadTool = Tool.define<typeof parameters, BrowserReadMetadata>("browser_read", {
  description:
    "Read page content from the current browser tab. Choose the content type: accessibility (structured accessibility tree), dom (full HTML), text (visible plain text), attributes (element attributes, requires locator), or style (computed CSS, requires locator).",
  parameters,
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)

    switch (params.type) {
      case "accessibility": {
        const snap = await tab.snapshot()
        const text = formatSnapshotText(snap.elements, { interactiveOnly: false })

        let output = text || "(empty page)"
        const truncated = output.length > params.maxBytes || snap.truncated
        output = truncateHTML(output, params.maxBytes)

        return {
          title: `Page structure of ${tab.url || tab.title || "page"}`,
          output,
          metadata: {
            url: tab.url,
            tabId: tab.id,
            type: "accessibility",
            elementsCount: snap.elements.length,
            truncated,
          },
        }
      }

      case "dom": {
        const html = await readDOM(tab, params.locator)
        const truncated = Buffer.byteLength(html, "utf-8") > params.maxBytes
        const output = domSnapshot(html, params.maxBytes)

        return {
          title: `DOM of ${tab.url || tab.title || "page"}`,
          output,
          metadata: {
            url: tab.url,
            tabId: tab.id,
            type: "dom",
            byteLength: Buffer.byteLength(html, "utf-8"),
            truncated,
          },
        }
      }

      case "text": {
        const html = params.locator
          ? await readDOM(tab, params.locator)
          : ((await tab.evaluate("document.body.innerText")) as string) || ""
        const rawText = pageText(html)
        const truncated = Buffer.byteLength(rawText, "utf-8") > params.maxBytes
        const output = truncateHTML(rawText, params.maxBytes)

        return {
          title: `Text of ${tab.url || tab.title || "page"}`,
          output: output || "(no visible text)",
          metadata: {
            url: tab.url,
            tabId: tab.id,
            type: "text",
            byteLength: Buffer.byteLength(rawText, "utf-8"),
            truncated,
          },
        }
      }

      case "attributes": {
        if (!params.locator) throw new Error("locator is required for attributes read type")
        const attrs = await resolveAttributes(tab, params.locator)
        const lines = Object.keys(attrs).length
          ? Object.entries(attrs)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n")
          : "(no attributes)"
        const output = truncateHTML(lines, params.maxBytes)

        return {
          title: `Attributes of element on ${tab.url || tab.title || "page"}`,
          output,
          metadata: {
            url: tab.url,
            tabId: tab.id,
            type: "attributes",
            attributeCount: Object.keys(attrs).length,
            truncated: false,
          },
        }
      }

      case "style": {
        if (!params.locator) throw new Error("locator is required for style read type")
        const styles = await resolveComputedStyles(tab, params.locator)
        const lines = Object.keys(styles).length
          ? Object.entries(styles)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n")
          : "(no computed styles)"
        const output = truncateHTML(lines, params.maxBytes)

        return {
          title: `Computed style of element on ${tab.url || tab.title || "page"}`,
          output,
          metadata: {
            url: tab.url,
            tabId: tab.id,
            type: "style",
            propertyCount: Object.keys(styles).length,
            truncated: false,
          },
        }
      }
    }
  },
})

// ── Locator resolution helpers ─────────────────────────────────────

type LocatorInput = z.infer<typeof BrowserLocator.LocatorInputSchema>

async function readDOM(tab: BrowserTab, locator?: LocatorInput): Promise<string> {
  if (!locator) {
    const html = (await tab.evaluate("document.documentElement.outerHTML")) as string
    if (!html) throw new Error("Could not read page DOM")
    return html
  }

  switch (locator.kind) {
    case "ref": {
      const ref = locator.value.startsWith("@e") ? locator.value : `@e${locator.value}`
      const resolved = await tab.resolveRef(ref)
      if (!resolved) throw new Error(`Element not found: ${locator.value}`)
      const cdp = tab.cdp
      if (!cdp) throw new Error("CDP connection not available")
      const result = (await cdp.send("DOM.getOuterHTML", {
        backendNodeId: resolved.backendNodeId,
      })) as { outerHTML: string }
      return result.outerHTML
    }
    case "css": {
      const html = (await tab.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(locator.value)}); return el ? el.outerHTML : null; })()`,
      )) as string | null
      if (!html) throw new Error(`Element not found for CSS selector: ${locator.value}`)
      return html
    }
    default:
      throw new Error(`Locator kind "${locator.kind}" is not supported for DOM reading. Use "ref" or "css".`)
  }
}

async function resolveAttributes(tab: BrowserTab, locator: LocatorInput): Promise<Record<string, string>> {
  const rawAttrs = await extractAttributesRaw(tab, locator)
  if (!rawAttrs || Object.keys(rawAttrs).length === 0) return {}
  return elementAttributes({ attributes: rawAttrs }, Object.keys(rawAttrs))
}

async function extractAttributesRaw(tab: BrowserTab, locator: LocatorInput): Promise<Record<string, string>> {
  switch (locator.kind) {
    case "ref": {
      const ref = locator.value.startsWith("@e") ? locator.value : `@e${locator.value}`
      const resolved = await tab.resolveRef(ref)
      if (!resolved) throw new Error(`Element not found: ${ref}`)
      const cdp = tab.cdp
      if (!cdp) throw new Error("CDP connection not available")
      const result = (await cdp.send("DOM.describeNode", {
        backendNodeId: resolved.backendNodeId,
      })) as { node: { attributes?: string[] } }
      const attrArray = result.node.attributes ?? []
      const attrs: Record<string, string> = {}
      for (let i = 0; i < attrArray.length; i += 2) {
        attrs[attrArray[i]] = attrArray[i + 1] ?? ""
      }
      return attrs
    }
    case "css": {
      const attrs = (await tab.evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(locator.value)});
          if (!el) return null;
          const result = {};
          for (const attr of el.attributes) { result[attr.name] = attr.value; }
          return result;
        })()`,
      )) as Record<string, string> | null
      if (!attrs) throw new Error(`Element not found for CSS selector: ${locator.value}`)
      return attrs
    }
    default:
      throw new Error(`Locator kind "${locator.kind}" is not supported for attribute reading. Use "ref" or "css".`)
  }
}

async function resolveComputedStyles(tab: BrowserTab, locator: LocatorInput): Promise<Record<string, string>> {
  switch (locator.kind) {
    case "ref": {
      const ref = locator.value.startsWith("@e") ? locator.value : `@e${locator.value}`
      const resolved = await tab.resolveRef(ref)
      if (!resolved) throw new Error(`Element not found: ${ref}`)
      const cdp = tab.cdp
      if (!cdp) throw new Error("CDP connection not available")
      const result = (await cdp.send("CSS.getComputedStyleForNode", {
        nodeId: resolved.backendNodeId,
      })) as { computedStyle?: Array<{ name: string; value: string }> }
      const propList = result.computedStyle ?? []
      const styles: Record<string, string> = {}
      for (const prop of propList) {
        styles[prop.name] = prop.value
      }
      if (Object.keys(styles).length === 0) return {}
      return computedStyle({ computedStyles: styles }, Object.keys(styles))
    }
    case "css": {
      const styles = (await tab.evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(locator.value)});
          if (!el) return null;
          const computed = getComputedStyle(el);
          const result = {};
          for (let i = 0; i < computed.length; i++) {
            const name = computed[i];
            result[name] = computed.getPropertyValue(name);
          }
          return result;
        })()`,
      )) as Record<string, string> | null
      if (!styles) throw new Error(`Element not found for CSS selector: ${locator.value}`)
      if (Object.keys(styles).length === 0) return {}
      return computedStyle({ computedStyles: styles }, Object.keys(styles))
    }
    default:
      throw new Error(`Locator kind "${locator.kind}" is not supported for style reading. Use "ref" or "css".`)
  }
}
