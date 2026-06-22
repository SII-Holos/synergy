import z from "zod"
import type { Page, Locator } from "playwright"
import { BrowserLocator } from "./locator.js"

// ════════════════════════════════════════════════════════════════
//  Action names — canonical list
// ════════════════════════════════════════════════════════════════

export const ActionNames = [
  "click",
  "dblclick",
  "press",
  "fill",
  "selectOption",
  "check",
  "uncheck",
  "hover",
  "type",
  "mouseMove",
  "drag",
  "scroll",
] as const

export type ActionName = (typeof ActionNames)[number]

// ════════════════════════════════════════════════════════════════
//  requiredParams — action → required param names
// ════════════════════════════════════════════════════════════════

export function requiredParams(action: string): string[] {
  switch (action) {
    case "click":
    case "dblclick":
    case "check":
    case "uncheck":
    case "hover":
    case "mouseMove":
      return ["locator"]
    case "press":
      return ["key"]
    case "fill":
      return ["locator", "value"]
    case "selectOption":
      return ["locator", "values"]
    case "type":
      return ["locator", "text"]
    case "drag":
      return ["locator", "target"]
    case "scroll":
      return []
    default:
      return []
  }
}

// ════════════════════════════════════════════════════════════════
//  Schema
// ════════════════════════════════════════════════════════════════

const LocatorSchema = BrowserLocator.LocatorInputSchema

const MODIFIER_NAMES = ["Alt", "Control", "Meta", "Shift"] as const

export namespace BrowserActions {
  export const ActionInputSchema = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("click"),
      locator: LocatorSchema,
      button: z.enum(["left", "right", "middle"]).optional(),
    }),
    z.object({ action: z.literal("dblclick"), locator: LocatorSchema }),
    z.object({
      action: z.literal("press"),
      key: z.string().min(1),
      modifiers: z.array(z.enum(MODIFIER_NAMES)).optional(),
    }),
    z.object({ action: z.literal("fill"), locator: LocatorSchema, value: z.string() }),
    z.object({
      action: z.literal("selectOption"),
      locator: LocatorSchema,
      values: z.array(z.string()).min(1),
    }),
    z.object({ action: z.literal("check"), locator: LocatorSchema }),
    z.object({ action: z.literal("uncheck"), locator: LocatorSchema }),
    z.object({ action: z.literal("hover"), locator: LocatorSchema }),
    z.object({ action: z.literal("type"), locator: LocatorSchema, text: z.string().min(1) }),
    z.object({
      action: z.literal("mouseMove"),
      locator: LocatorSchema,
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    z.object({
      action: z.literal("drag"),
      locator: LocatorSchema,
      target: LocatorSchema,
      button: z.enum(["left", "right", "middle"]).optional(),
      steps: z.number().int().min(2).optional(),
    }),
    z.object({
      action: z.literal("scroll"),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
  ])

  export type ActionInput = z.infer<typeof ActionInputSchema>

  export const ACTION_LIST: readonly ActionName[] = ActionNames

  export function isValidAction(a: string): a is ActionName {
    return (ActionNames as readonly string[]).includes(a)
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Playwright-backed action execution
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Execute a browser action using Playwright APIs.
   * `page` must be a Playwright Page.
   * `locator` is an optional pre-resolved Playwright Locator for actions
   * that target a specific element.
   */
  export async function run(
    page: Page,
    input: ActionInput,
    resolveLocator: (li: BrowserLocator.LocatorInput) => Locator,
  ): Promise<{ title: string; output: string }> {
    switch (input.action) {
      case "click": {
        const el = resolveLocator(input.locator)
        await el.click({ button: input.button ?? "left" })
        return { title: "Clicked", output: "Element clicked" }
      }
      case "dblclick": {
        const el = resolveLocator(input.locator)
        await el.dblclick()
        return { title: "Double-clicked", output: "Element double-clicked" }
      }
      case "press": {
        const mods = input.modifiers ?? []
        const combo = [...mods, input.key].join("+")
        await page.keyboard.press(combo)
        return { title: "Pressed", output: `Pressed ${combo}` }
      }
      case "fill": {
        const el = resolveLocator(input.locator)
        await el.fill(input.value)
        return { title: "Filled", output: `Filled with "${input.value}"` }
      }
      case "selectOption": {
        const el = resolveLocator(input.locator)
        await el.selectOption(input.values)
        return { title: "Selected", output: `Selected ${input.values.join(", ")}` }
      }
      case "check": {
        const el = resolveLocator(input.locator)
        await el.check()
        return { title: "Checked", output: "Element checked" }
      }
      case "uncheck": {
        const el = resolveLocator(input.locator)
        await el.uncheck()
        return { title: "Unchecked", output: "Element unchecked" }
      }
      case "hover": {
        const el = resolveLocator(input.locator)
        await el.hover()
        return { title: "Hovered", output: "Hovered over element" }
      }
      case "type": {
        const el = resolveLocator(input.locator)
        await el.click()
        await page.keyboard.type(input.text, { delay: 10 })
        return { title: "Typed", output: `Typed "${input.text}"` }
      }
      case "mouseMove": {
        if (input.locator) {
          const el = resolveLocator(input.locator)
          await el.hover()
        } else {
          await page.mouse.move(input.x ?? 0, input.y ?? 0)
        }
        return { title: "Mouse moved", output: "Mouse moved" }
      }
      case "drag": {
        const source = resolveLocator(input.locator)
        const target = resolveLocator(input.target)
        await source.dragTo(target, { force: true })
        return { title: "Dragged", output: "Element dragged" }
      }
      case "scroll": {
        await page.mouse.wheel(input.x ?? 0, input.y ?? 0)
        return { title: "Scrolled", output: "Page scrolled" }
      }
    }
  }

  /**
   * Resolve locators in the input and execute the Playwright action.
   * Combines toPlaywrightLocator + run in one call.
   */
  export async function resolveAndRun(page: Page, input: ActionInput): Promise<{ title: string; output: string }> {
    const resolveLocator = (li: BrowserLocator.LocatorInput): Locator => BrowserLocator.toPlaywrightLocator(page, li)

    return run(page, input, resolveLocator)
  }
}

// ════════════════════════════════════════════════════════════════
//  Public API
// ════════════════════════════════════════════════════════════════

export function validateAction(input: unknown): { ok: boolean; message?: string } {
  const result = BrowserActions.ActionInputSchema.safeParse(input)
  if (result.success) return { ok: true }
  return { ok: false, message: result.error.message }
}
