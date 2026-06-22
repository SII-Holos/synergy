import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { Instance } from "../scope/instance"

export const BrowserScrollTool = Tool.define("browser_scroll", {
  description:
    "Scroll the browser page. Positive deltaY scrolls down. Optionally scroll a specific element into view first.",
  parameters: z.object({
    deltaY: z.number().describe("Vertical scroll amount in pixels (positive = down)"),
    deltaX: z.number().optional().describe("Horizontal scroll amount in pixels (positive = right)"),
    selector: z.string().optional().describe("Snap ref or CSS selector to scroll into view before scrolling"),
    tabId: z.string().optional().describe("Tab to operate on. Uses the active tab when omitted."),
  }),
  async execute(params, ctx) {
    await BrowserRuntime.ensure()
    const helperCtx: BrowserToolHelper.Context = {
      scopeID: Instance.scope.id,
      sessionID: ctx.sessionID,
    }
    const tab = BrowserToolHelper.getTab(helperCtx, params.tabId)

    if (params.selector) {
      if (params.selector.startsWith("@e")) {
        const resolved = await tab.resolveRef(params.selector)
        if (!resolved) {
          throw new Error(`Element ${params.selector} not found. Take a new snapshot.`)
        }
        await tab.evaluate(
          `(() => { document.elementFromPoint(${resolved.x + resolved.width / 2}, ${resolved.y + resolved.height / 2})?.scrollIntoView({ block: "nearest" }); })()`,
        )
      } else {
        const found = (await tab.evaluate(
          `(() => {
            const el = document.querySelector(${JSON.stringify(params.selector)});
            if (!el) return false;
            el.scrollIntoView({ block: "nearest" });
            return true;
          })()`,
        )) as boolean

        if (!found) {
          throw new Error(`Element "${params.selector}" not found on the page.`)
        }
      }
    }

    await tab.scroll(params.deltaX ?? 0, params.deltaY)
    const dir = params.deltaY > 0 ? "down" : params.deltaY < 0 ? "up" : ""
    const detail = params.selector ? ` after scrolling ${params.selector} into view` : ""
    return {
      title: "Scrolled",
      output: `Scrolled${dir ? " " + dir : ""} by (${params.deltaX ?? 0}, ${params.deltaY})${detail}`,
      metadata: {},
    }
  },
})
