export namespace BrowserActions {
  export type ActionName =
    | "click"
    | "dblclick"
    | "fill"
    | "type"
    | "press"
    | "selectOption"
    | "check"
    | "uncheck"
    | "hover"
    | "mouseMove"
    | "drag"
    | "scroll"

  export const ACTION_LIST: readonly ActionName[] = [
    "click",
    "dblclick",
    "fill",
    "type",
    "press",
    "selectOption",
    "check",
    "uncheck",
    "hover",
    "mouseMove",
    "drag",
    "scroll",
  ]

  export function isValidAction(a: string): a is ActionName {
    return (ACTION_LIST as readonly string[]).includes(a)
  }

  export interface CDPCommand {
    method: string
    params: Record<string, unknown>
  }

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
        params: { type: "rawKeyDown", windowsVirtualKeyCode: 65, key: "a", code: "KeyA", modifiers: 2 },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", windowsVirtualKeyCode: 65, key: "a", code: "KeyA", modifiers: 2 },
      },
      { method: "Input.insertText", params: { text: value } },
    ]
  }

  export function buildType(text: string): CDPCommand[] {
    return [{ method: "Input.insertText", params: { text } }]
  }

  export function buildPress(key: string, modifiers?: number): CDPCommand[] {
    return [
      { method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key, modifiers: modifiers ?? 0 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key, modifiers: modifiers ?? 0 } },
    ]
  }

  export function buildHover(x: number, y: number): CDPCommand[] {
    return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y } }]
  }

  export function buildMouseMove(x: number, y: number): CDPCommand[] {
    return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y } }]
  }

  export function buildScroll(deltaX: number, deltaY: number): CDPCommand[] {
    return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 0, y: 0, deltaX, deltaY } }]
  }
}
