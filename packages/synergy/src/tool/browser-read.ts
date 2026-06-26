import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper, formatSnapshotText } from "./browser-shared"
import { BrowserLocator } from "../browser/locator"
import { truncateHTML, domSnapshot, pageText, elementAttributes, computedStyle, visibleDOM } from "../browser/page-read"
import type { BrowserTab } from "../browser/tab"
import type { Page, Locator } from "playwright"
import { ToolTimeout } from "./timeout"
import { BrowserOwner } from "../browser/owner"

const parameters = z.object({
  type: z
    .enum(["accessibility", "dom", "text", "attributes", "style", "visibleDom"])
    .describe("Type of page content to read."),
  locator: BrowserLocator.LocatorInputSchema.optional().describe(
    "Element locator. Required for attributes/style; optional for accessibility/dom/text/visibleDom (limits reading to a specific element).",
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
    "Read page content from the current browser tab. Choose the content type: accessibility (structured accessibility tree), dom (full HTML), text (visible plain text), attributes (element attributes, requires locator), style (computed CSS, requires locator), or visibleDom (only elements visible in the viewport).",
  parameters,
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    await BrowserToolHelper.markActivity(ctx, tab, "reading", "browser_read", `Reading ${params.type}`)
    try {
      switch (params.type) {
        case "accessibility": {
          const snap = await BrowserToolHelper.executeControl(owner, { type: "snapshot", tabId: tab.id })
          if (snap.type !== "snapshot") throw new Error("Browser snapshot command returned an unexpected result")
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
          const html = await readDOM(owner, tab, params.locator)
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
            ? await readDOM(owner, tab, params.locator)
            : ((await evaluate(owner, tab, "document.body.innerText")) as string) || ""
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
          const attrs = await resolveAttributes(owner, tab, params.locator)
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
          const styles = await resolveComputedStyles(owner, tab, params.locator)
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

        case "visibleDom": {
          const snap = await BrowserToolHelper.executeControl(owner, { type: "snapshot", tabId: tab.id })
          if (snap.type !== "snapshot") throw new Error("Browser snapshot command returned an unexpected result")
          const elements = snap.elements
          const filtered = visibleDOM(
            elements.map((el) => ({
              ...el,
              style: {} as Record<string, string>,
              bounds: { x: 0, y: 0, width: 0, height: 0 },
            })),
            1920,
            1080,
          )
          const text = formatSnapshotText(filtered, { interactiveOnly: false })
          let output = text || "(no visible elements)"
          const truncated = output.length > params.maxBytes || snap.truncated
          output = truncateHTML(output, params.maxBytes)

          return {
            title: `Visible DOM of ${tab.url || tab.title || "page"}`,
            output,
            metadata: {
              url: tab.url,
              tabId: tab.id,
              type: "visibleDom",
              elementsCount: filtered.length,
              truncated,
            },
          }
        }
      }
    } finally {
      await BrowserToolHelper.markIdle(ctx, tab, "browser_read")
    }
  },
})

// ── Locator resolution helpers ─────────────────────────────────────

type LocatorInput = z.infer<typeof BrowserLocator.LocatorInputSchema>

async function evaluate(owner: BrowserOwner.Info, tab: BrowserTab, expression: string): Promise<unknown> {
  const result = await BrowserToolHelper.executeControl(owner, { type: "evaluate", tabId: tab.id, expression })
  if (result.type !== "evaluation") throw new Error("Browser evaluate command returned an unexpected result")
  return result.value
}

async function readDOM(owner: BrowserOwner.Info, tab: BrowserTab, locator?: LocatorInput): Promise<string> {
  if (!locator) {
    const html = (await evaluate(owner, tab, "document.documentElement.outerHTML")) as string
    if (!html) throw new Error("Could not read page DOM")
    return html
  }

  // Playwright path (all locator kinds supported via toPlaywrightLocator)
  if (tab.page) {
    const pwLocator = BrowserLocator.toPlaywrightLocator(tab.page, locator)
    try {
      await pwLocator.waitFor({ state: "attached", timeout: ToolTimeout.DEFAULTS.browserLocatorMs })
      const html = (await pwLocator.evaluate((el) => (el as HTMLElement).outerHTML)) as string
      return html
    } catch {
      // fall through to evaluate-based resolution
    }
  }

  // Evaluate-based fallback (css, xpath, testId)
  const query = BrowserLocator.buildElementQuery(locator)
  if (query) {
    const html = (await evaluate(owner, tab, `(() => { const el = ${query}; return el ? el.outerHTML : null; })()`)) as
      | string
      | null
    if (!html) throw new Error(`Element not found for ${locator.kind} locator: ${String(locator.value)}`)
    return html
  }

  throw new Error(`Locator kind "${locator.kind}" is not supported for DOM reading`)
}

async function resolveAttributes(
  owner: BrowserOwner.Info,
  tab: BrowserTab,
  locator: LocatorInput,
): Promise<Record<string, string>> {
  const rawAttrs = await extractAttributesRaw(owner, tab, locator)
  if (!rawAttrs || Object.keys(rawAttrs).length === 0) return {}
  return elementAttributes({ attributes: rawAttrs }, Object.keys(rawAttrs))
}

async function extractAttributesRaw(
  owner: BrowserOwner.Info,
  tab: BrowserTab,
  locator: LocatorInput,
): Promise<Record<string, string>> {
  // Playwright path (all locator kinds)
  if (tab.page) {
    const pwLocator = BrowserLocator.toPlaywrightLocator(tab.page, locator)
    try {
      await pwLocator.waitFor({ state: "attached", timeout: ToolTimeout.DEFAULTS.browserLocatorMs })
      const attrs = (await pwLocator.evaluate((el) => {
        const result: Record<string, string> = {}
        for (const attr of (el as HTMLElement).attributes) {
          result[attr.name] = attr.value
        }
        return result
      })) as Record<string, string>
      return attrs
    } catch {
      // fall through to evaluate-based resolution
    }
  }

  // Evaluate-based fallback (css, xpath, testId)
  const query = BrowserLocator.buildElementQuery(locator)
  if (query) {
    const attrs = (await evaluate(
      owner,
      tab,
      `(() => {
        const el = ${query};
        if (!el) return null;
        const result = {};
        for (const attr of el.attributes) { result[attr.name] = attr.value; }
        return result;
      })()`,
    )) as Record<string, string> | null
    if (!attrs) throw new Error(`Element not found for ${locator.kind} locator: ${String(locator.value)}`)
    return attrs
  }

  throw new Error(`Locator kind "${locator.kind}" is not supported for attribute reading`)
}

async function resolveComputedStyles(
  owner: BrowserOwner.Info,
  tab: BrowserTab,
  locator: LocatorInput,
): Promise<Record<string, string>> {
  // Playwright path (all locator kinds)
  if (tab.page) {
    const pwLocator = BrowserLocator.toPlaywrightLocator(tab.page, locator)
    try {
      await pwLocator.waitFor({ state: "attached", timeout: ToolTimeout.DEFAULTS.browserLocatorMs })
      const styles = (await pwLocator.evaluate((el) => {
        const computed = getComputedStyle(el as HTMLElement)
        const result: Record<string, string> = {}
        for (let i = 0; i < computed.length; i++) {
          const name = computed[i]
          result[name] = computed.getPropertyValue(name)
        }
        return result
      })) as Record<string, string>
      if (Object.keys(styles).length === 0) return {}
      return computedStyle({ computedStyles: styles }, Object.keys(styles))
    } catch {
      // fall through to evaluate-based resolution
    }
  }

  // Evaluate-based fallback (css, xpath, testId)
  const query = BrowserLocator.buildElementQuery(locator)
  if (query) {
    const styles = (await evaluate(
      owner,
      tab,
      `(() => {
        const el = ${query};
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
    if (!styles) throw new Error(`Element not found for ${locator.kind} locator: ${String(locator.value)}`)
    if (Object.keys(styles).length === 0) return {}
    return computedStyle({ computedStyles: styles }, Object.keys(styles))
  }

  throw new Error(`Locator kind "${locator.kind}" is not supported for style reading`)
}
