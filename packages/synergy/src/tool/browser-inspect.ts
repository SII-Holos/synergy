import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"

export const BrowserInspectTool = Tool.define("browser_inspect", {
  description:
    "Inspect an element on the current browser page by accessibility ref (e.g. @e12). Returns the element's tag name, attributes, bounding box, and text content. Use refs from browser_snapshot output to target specific elements.",
  parameters: z.object({
    ref: z.string().describe("Accessibility ref from a snapshot (e.g. @e12)."),
    pageId: z.string().optional().describe("Page ID. Uses the session page if omitted."),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.resolvePage(ctx, params.pageId)
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

        const resolved = await BrowserToolHelper.executeControl(owner, {
          type: "resolveRef",
          pageId: tab.id,
          ref: params.ref,
        })
        if (resolved.type !== "resolvedRef") throw new Error("Browser ref command returned an unexpected result")
        if (!resolved.box) throw new Error(`Element not found for ref: ${params.ref}`)

        const { x, y, width, height } = resolved.box
        const elementInfoResult = await BrowserToolHelper.executeControl(owner, {
          type: "evaluate",
          pageId: tab.id,
          expression: `(() => {
            const ref = ${JSON.stringify(params.ref)};
            const index = Number(ref.replace(/^@e/, "")) - 1;
            const elements = Array.from(
              document.querySelectorAll("a,button,input,textarea,select,[role],summary,[tabindex]:not([tabindex='-1'])")
            ).filter((el) => {
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            });
            const el = elements[index];
            if (!el) return null;
            const attrs = {};
            for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
            return {
              tag: el.localName,
              attributes: attrs,
              text: el.textContent?.trim()?.slice(0, 2000) ?? "",
            };
          })()`,
        })
        if (elementInfoResult.type !== "evaluation") {
          throw new Error("Browser inspect evaluate command returned an unexpected result")
        }
        const elementInfo = elementInfoResult.value as {
          tag: string
          attributes: Record<string, string>
          text: string
        } | null

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
            pageId: tab.id,
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
