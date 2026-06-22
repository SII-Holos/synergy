import z from "zod"
import { BrowserLocator } from "./locator.js"

// ════════════════════════════════════════════════════════════════
//  Modifier support
// ════════════════════════════════════════════════════════════════

const MODIFIER_NAMES = ["Alt", "Control", "Meta", "Shift"] as const

function modifierMask(name: string): number {
  switch (name) {
    case "Alt":
      return 1
    case "Control":
      return 2
    case "Meta":
      return 4
    case "Shift":
      return 8
    default:
      return 0
  }
}

// ════════════════════════════════════════════════════════════════
//  Virtual key code lookup
// ════════════════════════════════════════════════════════════════

const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Escape: 27,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  a: 65,
  b: 66,
  c: 67,
  d: 68,
  e: 69,
  f: 70,
  g: 71,
  h: 72,
  i: 73,
  j: 74,
  k: 75,
  l: 76,
  m: 77,
  n: 78,
  o: 79,
  p: 80,
  q: 81,
  r: 82,
  s: 83,
  t: 84,
  u: 85,
  v: 86,
  w: 87,
  x: 88,
  y: 89,
  z: 90,
  "0": 48,
  "1": 49,
  "2": 50,
  "3": 51,
  "4": 52,
  "5": 53,
  "6": 54,
  "7": 55,
  "8": 56,
  "9": 57,
}

function keyToVirtualKeyCode(key: string): number {
  if (KEY_CODES[key] !== undefined) return KEY_CODES[key]
  return key.charCodeAt(0)
}

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
//  BrowserActions namespace — schema + internal builders
// ════════════════════════════════════════════════════════════════

const LocatorSchema = BrowserLocator.LocatorInputSchema

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

  export interface CDPCommand {
    method: string
    params: Record<string, unknown>
  }

  export const ACTION_LIST: readonly ActionName[] = ActionNames

  export function isValidAction(a: string): a is ActionName {
    return (ActionNames as readonly string[]).includes(a)
  }

  // ── Legacy builders (kept for backward compat) ──────────────────

  export function buildClick(x: number, y: number, count?: number): CDPCommand[] {
    return [
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x, y, button: "left", clickCount: count ?? 1 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x, y, button: "left", clickCount: count ?? 1 },
      },
    ]
  }

  export function buildDblClick(x: number, y: number): CDPCommand[] {
    return [...buildClick(x, y, 1), ...buildClick(x, y, 2)]
  }

  export function buildFill(value: string): CDPCommand[] {
    return [
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "rawKeyDown",
          windowsVirtualKeyCode: 65,
          key: "a",
          code: "KeyA",
          modifiers: 2,
        },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyUp",
          windowsVirtualKeyCode: 65,
          key: "a",
          code: "KeyA",
          modifiers: 2,
        },
      },
      { method: "Input.insertText", params: { text: value } },
    ]
  }

  export function buildType(text: string): CDPCommand[] {
    return [{ method: "Input.insertText", params: { text } }]
  }

  export function buildPress(key: string, modifiers?: number): CDPCommand[] {
    return [
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "rawKeyDown", key, modifiers: modifiers ?? 0 },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key, modifiers: modifiers ?? 0 },
      },
    ]
  }

  export function buildHover(x: number, y: number): CDPCommand[] {
    return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y } }]
  }

  export function buildMouseMove(x: number, y: number): CDPCommand[] {
    return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y } }]
  }

  export function buildScroll(deltaX: number, deltaY: number): CDPCommand[] {
    return [
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: 0, y: 0, deltaX, deltaY },
      },
    ]
  }

  export function buildDrag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    button: "left" | "right" | "middle" = "left",
    steps = 2,
  ): CDPCommand[] {
    const cmds: CDPCommand[] = []
    cmds.push({
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: startX, y: startY, button, clickCount: 1 },
    })
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1)
      const x = Math.round(startX + (endX - startX) * t)
      const y = Math.round(startY + (endY - startY) * t)
      cmds.push({
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x, y, button },
      })
    }
    cmds.push({
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: endX, y: endY, button, clickCount: 1 },
    })
    return cmds
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

function escapeExpr(s: string): string {
  return JSON.stringify(s)
}

export function buildCdpCommands(action: BrowserActions.ActionInput): BrowserActions.CDPCommand[] {
  switch (action.action) {
    case "click": {
      const button = action.button ?? "left"
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mousePressed", x: 0, y: 0, button, clickCount: 1 },
        },
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseReleased", x: 0, y: 0, button, clickCount: 1 },
        },
      ]
    }
    case "dblclick":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mousePressed", x: 0, y: 0, button: "left", clickCount: 2 },
        },
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseReleased", x: 0, y: 0, button: "left", clickCount: 1 },
        },
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mousePressed", x: 0, y: 0, button: "left", clickCount: 2 },
        },
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseReleased", x: 0, y: 0, button: "left", clickCount: 2 },
        },
      ]
    case "press": {
      let modifiers = 0
      if (action.modifiers) {
        for (const m of action.modifiers) modifiers |= modifierMask(m)
      }
      return [
        {
          method: "Input.dispatchKeyEvent",
          params: {
            type: "keyDown",
            key: action.key,
            windowsVirtualKeyCode: keyToVirtualKeyCode(action.key),
            modifiers,
          },
        },
      ]
    }
    case "fill":
      return [
        { method: "Runtime.evaluate", params: { expression: "this.focus(); this.select()" } },
        { method: "Input.insertText", params: { text: action.value } },
        { method: "Runtime.evaluate", params: { expression: "this.dispatchEvent(new Event('input',{bubbles:true}))" } },
      ]
    case "selectOption": {
      const vals = action.values.map((v) => escapeExpr(v))
      return [
        {
          method: "Runtime.evaluate",
          params: {
            expression: `(() => {
  const vals = [${vals.join(", ")}];
  const set = new Set(vals);
  const opts = this.options;
  for (let i = 0; i < opts.length; i++) {
    opts[i].selected = set.has(opts[i].value);
  }
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
})()`,
          },
        },
      ]
    }
    case "check":
      return [
        {
          method: "Runtime.evaluate",
          params: {
            expression:
              "if (!this.checked) { this.click(); this.dispatchEvent(new Event('change', { bubbles: true })) }",
          },
        },
      ]
    case "uncheck":
      return [
        {
          method: "Runtime.evaluate",
          params: {
            expression:
              "if (this.checked) { this.click(); this.dispatchEvent(new Event('change', { bubbles: true })) }",
          },
        },
      ]
    case "hover":
      return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 0, y: 0 } }]
    case "type": {
      const cmds: BrowserActions.CDPCommand[] = []
      for (const ch of action.text) {
        cmds.push({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: ch } })
        cmds.push({ method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: ch } })
      }
      return cmds
    }
    case "mouseMove":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseMoved", x: action.x ?? 0, y: action.y ?? 0 },
        },
      ]
    case "drag":
      return BrowserActions.buildDrag(0, 0, 0, 0, action.button ?? "left", action.steps ?? 2)
    case "scroll":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            x: 0,
            y: 0,
            deltaX: action.x ?? 0,
            deltaY: action.y ?? 0,
          },
        },
      ]
  }
}
