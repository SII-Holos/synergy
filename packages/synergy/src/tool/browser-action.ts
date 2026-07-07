import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserActions } from "../browser/actions"
import { BrowserLocator } from "../browser/locator"
import { BrowserOwner } from "../browser/owner"

export const BrowserActionTool = Tool.define("browser_action", {
  description:
    "Perform a browser action using Playwright-style locators. Supports click, dblclick, fill, type, press, selectOption, check, uncheck, hover, mouseMove, drag, and scroll actions.",
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
    pageId: z.string().optional(),
  }),
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const tab = await BrowserToolHelper.resolvePage(ctx, params.pageId)
    return BrowserToolHelper.withActivity(
      ctx,
      tab,
      "acting",
      "browser_action",
      `Running ${params.action}`,
      async () => {
        if (tab.page) {
          const resolveLocator = (li: BrowserLocator.LocatorInput) => BrowserLocator.toPlaywrightLocator(tab.page!, li)
          const actionInput = {
            action: params.action,
            locator: params.locator,
            target: params.target,
            text: params.text,
            key: params.key,
            values: params.values,
            x: params.x,
            y: params.y,
          } as BrowserActions.ActionInput
          const result = await BrowserActions.run(tab.page, actionInput, resolveLocator)
          return { ...result, metadata: {} }
        }

        return runWorkspaceAction(owner, tab, params)
      },
    )
  },
})

async function runWorkspaceAction(
  owner: BrowserOwner.Info,
  tab: { id: string },
  params: {
    action: string
    locator?: BrowserLocator.LocatorInput
    target?: BrowserLocator.LocatorInput
    text?: string
    key?: string
    values?: string[]
    x?: number
    y?: number
    deltaX?: number
    deltaY?: number
  },
) {
  const ctl = (cmd: Parameters<typeof BrowserToolHelper.executeControl>[1]) =>
    BrowserToolHelper.executeControl(owner, { ...cmd, pageId: tab.id } as any)
  const resolveBox = async () => {
    if (!params.locator) throw new Error(`Action ${params.action} requires a locator`)
    const resolved = await BrowserLocator.resolveLocatorRef(tab as any, params.locator)
    if (!resolved) throw new Error(`Element not found for locator: ${JSON.stringify(params.locator)}`)
    return { cx: resolved.x + resolved.width / 2, cy: resolved.y + resolved.height / 2 }
  }

  switch (params.action) {
    case "click": {
      const { cx, cy } = await resolveBox()
      await ctl({ type: "click", x: cx, y: cy })
      return { title: "Clicked", output: "Element clicked", metadata: {} }
    }
    case "dblclick": {
      const { cx, cy } = await resolveBox()
      await ctl({ type: "click", x: cx, y: cy })
      await new Promise((r) => setTimeout(r, 80))
      await ctl({ type: "click", x: cx, y: cy })
      return { title: "Double-clicked", output: "Element double-clicked", metadata: {} }
    }
    case "check":
    case "uncheck": {
      const { cx, cy } = await resolveBox()
      await ctl({ type: "click", x: cx, y: cy })
      return {
        title: params.action === "check" ? "Checked" : "Unchecked",
        output: `Element ${params.action}ed`,
        metadata: {},
      }
    }
    case "fill": {
      const { cx, cy } = await resolveBox()
      await ctl({ type: "click", x: cx, y: cy })
      await ctl({ type: "typeText", text: params.text ?? "" })
      return { title: "Filled", output: `Filled with "${params.text ?? ""}"`, metadata: {} }
    }
    case "type": {
      const { cx, cy } = await resolveBox()
      await ctl({ type: "click", x: cx, y: cy })
      await ctl({ type: "typeText", text: params.text ?? "" })
      return { title: "Typed", output: `Typed "${params.text ?? ""}"`, metadata: {} }
    }
    case "selectOption": {
      const { cx, cy } = await resolveBox()
      await ctl({ type: "click", x: cx, y: cy })
      if (params.values && params.values.length > 0) {
        await ctl({ type: "typeText", text: params.values[0] })
      }
      return { title: "Selected", output: `Selected ${params.values?.join(", ") ?? ""}`, metadata: {} }
    }
    case "hover":
    case "mouseMove": {
      if (params.locator) {
        const { cx, cy } = await resolveBox()
        await ctl({ type: "mouse", action: "move", input: { x: cx, y: cy, button: "left" } })
      } else {
        await ctl({ type: "mouse", action: "move", input: { x: params.x ?? 0, y: params.y ?? 0, button: "left" } })
      }
      return { title: "Mouse moved", output: "Mouse moved", metadata: {} }
    }
    case "press": {
      const key = params.key
      if (!key) throw new Error("press action requires a key")
      await ctl({ type: "insertText", text: key })
      return { title: "Pressed", output: `Pressed ${key}`, metadata: {} }
    }
    case "drag": {
      throw new Error("Drag action is not supported in workspace mode. Use browser_click instead.")
    }
    case "scroll": {
      await ctl({ type: "scroll", deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0 })
      return { title: "Scrolled", output: "Page scrolled", metadata: {} }
    }
    default:
      throw new Error(`Unknown action: ${params.action}`)
  }
}
