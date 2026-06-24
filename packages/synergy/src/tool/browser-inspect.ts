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
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      "reading",
      "browser_inspect",
      `Inspecting ${params.ref}`,
      async () => {
        if (!params.ref.startsWith("@e")) {
          throw new Error(`Invalid ref: ${params.ref}. Expected format: @eN (e.g. @e12)`)
        }

        const resolved = await tab.resolveRef(params.ref)
        if (!resolved) throw new Error(`Element not found for ref: ${params.ref}`)

        const { x, y, width, height } = resolved
        const elementInfo = tab.page
          ? ((await tab.page.evaluate((ref) => {
              const index = Number(ref.replace(/^@e/, "")) - 1
              const elements = Array.from(
                document.querySelectorAll<HTMLElement>(
                  "a,button,input,textarea,select,[role],summary,[tabindex]:not([tabindex='-1'])",
                ),
              ).filter((el) => {
                const style = window.getComputedStyle(el)
                const rect = el.getBoundingClientRect()
                return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
              })
              const el = elements[index]
              if (!el) return null
              const attrs: Record<string, string> = {}
              for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value
              return {
                tag: el.localName,
                attributes: attrs,
                text: el.textContent?.trim()?.slice(0, 2000) ?? "",
              }
            }, params.ref)) as { tag: string; attributes: Record<string, string>; text: string } | null)
          : null

        const tag = elementInfo?.tag ?? "unknown"
        const attributes = elementInfo?.attributes ?? {}
        const text = elementInfo?.text ?? ""

        const properties: string[] = [`tag: <${tag}>`]
        if (Object.keys(attributes).length > 0) properties.push(`attributes: ${JSON.stringify(attributes)}`)
        if (width > 0 || height > 0) {
          properties.push(
            `bounds: { x: ${Math.round(x)}, y: ${Math.round(y)}, width: ${Math.round(width)}, height: ${Math.round(height)} }`,
          )
        }
        if (text) properties.push(`text: "${text}"`)

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
    )
  },
})
