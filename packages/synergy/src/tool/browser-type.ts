import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"

export const BrowserTypeTool = Tool.define("browser_type", {
  description:
    "Type text into a focused element in the browser. Optionally identify the element to focus first via a snapshot ref or CSS selector.",
  parameters: z.object({
    selector: z.string().describe("Snap ref (e.g. @e42) or CSS selector of the element to type into"),
    text: z.string().describe("Text to type"),
    tabId: z.string().optional().describe("Tab to operate on. Uses the active tab when omitted."),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      "acting",
      "browser_type",
      `Typing into ${params.selector}`,
      async () => {
        // Focus the target element
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
          const cx = resolved.box.x + resolved.box.width / 2
          const cy = resolved.box.y + resolved.box.height / 2
          await BrowserToolHelper.executeControl(owner, { type: "click", tabId: tab.id, x: cx, y: cy })
        } else {
          // CSS selector: focus via evaluate
          const evaluated = await BrowserToolHelper.executeControl(owner, {
            type: "evaluate",
            tabId: tab.id,
            expression: `(() => {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return false;
          el.focus();
          return true;
        })()`,
          })
          if (evaluated.type !== "evaluation") throw new Error("Browser evaluate command returned an unexpected result")
          const focused = evaluated.value as boolean

          if (!focused) {
            throw new Error(`Element "${params.selector}" not found on the page.`)
          }
        }

        await BrowserToolHelper.executeControl(owner, { type: "typeText", tabId: tab.id, text: params.text })
        return {
          title: "Typed",
          output: `Typed ${JSON.stringify(params.text)} into ${params.selector}`,
          metadata: {},
        }
      },
    )
  },
})
