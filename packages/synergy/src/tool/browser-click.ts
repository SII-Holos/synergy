import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserClickTool = Tool.define("browser_click", {
  description:
    "Click on an element in the browser. Use a @eN snapshot ref or a CSS selector. Ref is preferred after taking a snapshot.",
  parameters: z.object({
    selector: z.string().describe("Snap ref (e.g. @e42) or CSS selector of the element to click"),
    tabId: z.string().optional().describe("Tab to operate on. Uses the active tab when omitted."),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      "acting",
      "browser_click",
      `Clicking ${params.selector}`,
      async () => {
        if (params.selector.startsWith("@e")) {
          const resolved = await tab.resolveRef(params.selector)
          if (!resolved) {
            throw new Error(`Element ${params.selector} not found. Take a new snapshot.`)
          }
          const cx = resolved.x + resolved.width / 2
          const cy = resolved.y + resolved.height / 2
          await tab.click(cx, cy)
          return {
            title: "Clicked",
            output: `Clicked element ${params.selector} at (${Math.round(cx)}, ${Math.round(cy)})`,
            metadata: {},
          }
        }

        // CSS selector path — evaluate via CDP to find position and click
        const box = (await tab.evaluate(
          `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
        )) as { x: number; y: number; width: number; height: number } | null

        if (!box) {
          throw new Error(`Element "${params.selector}" not found on the page.`)
        }

        const cx = box.x + box.width / 2
        const cy = box.y + box.height / 2
        await tab.click(cx, cy)
        return {
          title: "Clicked",
          output: `Clicked "${params.selector}" at (${Math.round(cx)}, ${Math.round(cy)})`,
          metadata: {},
        }
      },
    )
  },
})
