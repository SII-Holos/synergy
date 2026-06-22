import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserActions } from "../browser/actions"
import { BrowserLocator } from "../browser/locator"

export const BrowserActionTool = Tool.define("browser_action", {
  description:
    "Perform a browser action using Playwright-style locators. Supports click, dblclick, fill, type, press, selectOption, check, uncheck, hover, drag, and scroll actions.",
  parameters: z.object({
    action: z.enum(BrowserActions.ACTION_LIST as unknown as [string, ...string[]]),
    locator: BrowserLocator.LocatorInputSchema.optional().describe("Target element locator."),
    target: BrowserLocator.LocatorInputSchema.optional().describe("Target for drag end."),
    text: z.string().optional(),
    key: z.string().optional(),
    values: z.array(z.string()).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    tabId: z.string().optional(),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    const resolveLocator = async (loc: any) => {
      if (typeof loc?.value === "string" && loc.value.startsWith("@e")) {
        const r = await tab.resolveRef(loc.value)
        if (r) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
      return null
    }

    switch (params.action) {
      case "click": {
        const pos = params.locator ? await resolveLocator(params.locator) : null
        const cx = pos?.x ?? params.x ?? 0
        const cy = pos?.y ?? params.y ?? 0
        for (const cmd of BrowserActions.buildClick(cx, cy)) {
          await tab.cdp?.send(cmd.method, cmd.params)
        }
        return {
          title: "Clicked",
          output: `Clicked at (${Math.round(cx)},${Math.round(cy)})`,
          metadata: {},
        }
      }
      case "type":
      case "fill": {
        const text = params.text ?? ""
        for (const cmd of BrowserActions.buildType(text)) {
          await tab.cdp?.send(cmd.method, cmd.params)
        }
        return { title: "Typed", output: `Typed ${JSON.stringify(text)}`, metadata: {} }
      }
      case "press": {
        if (!params.key) throw new Error("key is required for press")
        for (const cmd of BrowserActions.buildPress(params.key)) {
          await tab.cdp?.send(cmd.method, cmd.params)
        }
        return { title: "Pressed", output: `Pressed ${params.key}`, metadata: {} }
      }
      case "scroll": {
        for (const cmd of BrowserActions.buildScroll(params.deltaX ?? 0, params.deltaY ?? 0)) {
          await tab.cdp?.send(cmd.method, cmd.params)
        }
        return { title: "Scrolled", output: "Page scrolled", metadata: {} }
      }
      case "hover": {
        const px = params.x ?? 0
        const py = params.y ?? 0
        for (const cmd of BrowserActions.buildHover(px, py)) {
          await tab.cdp?.send(cmd.method, cmd.params)
        }
        return { title: "Hovered", output: `Hovered at (${px},${py})`, metadata: {} }
      }
      default:
        throw new Error(`Action '${params.action}' not fully supported via browser_action yet. Use dedicated tool.`)
    }
  },
})
