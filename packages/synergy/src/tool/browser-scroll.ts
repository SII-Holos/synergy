import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"

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
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    return BrowserToolHelper.withActivity(ctx, tab, "acting", "browser_scroll", "Scrolling page", async () => {
      if (params.selector) {
        if (params.selector.startsWith("@e")) {
          const resolved = await BrowserToolHelper.executeControl(owner, {
            type: "resolveRef",
            tabId: tab.id,
            ref: params.selector,
          })
          if (resolved.type !== "resolvedRef") throw new Error("Browser ref command returned an unexpected result")
          if (!resolved.box) {
            throw new Error(`Element ${params.selector} not found. Take a new snapshot.`)
          }
          await BrowserToolHelper.executeControl(owner, {
            type: "evaluate",
            tabId: tab.id,
            expression: `(() => { document.elementFromPoint(${resolved.box.x + resolved.box.width / 2}, ${resolved.box.y + resolved.box.height / 2})?.scrollIntoView({ block: "nearest" }); })()`,
          })
        } else {
          const evaluated = await BrowserToolHelper.executeControl(owner, {
            type: "evaluate",
            tabId: tab.id,
            expression: `(() => {
            const el = document.querySelector(${JSON.stringify(params.selector)});
            if (!el) return false;
            el.scrollIntoView({ block: "nearest" });
            return true;
          })()`,
          })
          if (evaluated.type !== "evaluation") throw new Error("Browser evaluate command returned an unexpected result")
          const found = evaluated.value as boolean

          if (!found) {
            throw new Error(`Element "${params.selector}" not found on the page.`)
          }
        }
      }

      await BrowserToolHelper.executeControl(owner, {
        type: "scroll",
        tabId: tab.id,
        deltaX: params.deltaX ?? 0,
        deltaY: params.deltaY,
      })
      const dir = params.deltaY > 0 ? "down" : params.deltaY < 0 ? "up" : ""
      const detail = params.selector ? ` after scrolling ${params.selector} into view` : ""
      return {
        title: "Scrolled",
        output: `Scrolled${dir ? " " + dir : ""} by (${params.deltaX ?? 0}, ${params.deltaY})${detail}`,
        metadata: {},
      }
    })
  },
})
