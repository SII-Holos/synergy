import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserActions } from "../browser/actions"
import { BrowserLocator } from "../browser/locator"

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
    tabId: z.string().optional(),
  }),
  async execute(params, ctx) {
    const tab = await BrowserToolHelper.resolveTab(ctx, params.tabId)
    const page = tab.page
    if (!page) throw new Error("No Playwright page available for browser actions")

    const resolveLocator = (li: BrowserLocator.LocatorInput) => BrowserLocator.toPlaywrightLocator(page, li)

    // Build the action input from tool parameters
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

    const result = await BrowserActions.run(page, actionInput, resolveLocator)
    return { ...result, metadata: {} }
  },
})
