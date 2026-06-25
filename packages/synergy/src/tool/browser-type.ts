import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"

export const BrowserTypeTool = Tool.define("browser_type", {
  description:
    "Type text into a focused element in the browser. Optionally identify the element to focus first via a snapshot ref or CSS selector.",
  parameters: z.object({
    selector: z.string().describe("Snap ref (e.g. @e42) or CSS selector of the element to type into"),
    text: z.string().describe("Text to type"),
    tabId: z.string().optional().describe("Tab to operate on. Uses the active tab when omitted."),
  }),
  async execute(params, ctx) {
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
          const resolved = await tab.resolveRef(params.selector)
          if (!resolved) {
            throw new Error(`Element ${params.selector} not found. Take a new snapshot.`)
          }
          const cx = resolved.x + resolved.width / 2
          const cy = resolved.y + resolved.height / 2
          await tab.click(cx, cy)
        } else {
          // CSS selector: focus via evaluate
          const focused = (await tab.evaluate(
            `(() => {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return false;
          el.focus();
          return true;
        })()`,
          )) as boolean

          if (!focused) {
            throw new Error(`Element "${params.selector}" not found on the page.`)
          }
        }

        await tab.type(params.text)
        return {
          title: "Typed",
          output: `Typed ${JSON.stringify(params.text)} into ${params.selector}`,
          metadata: {},
        }
      },
    )
  },
})
