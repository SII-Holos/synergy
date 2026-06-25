import { describe, expect, mock, test } from "bun:test"
import { BrowserInputDispatcher } from "../../src/browser/input.js"
import type { CDPHandle } from "../../src/browser/cdp.js"

function createPage() {
  return {
    viewportSize: mock(() => ({ width: 800, height: 600 })),
    mouse: {
      move: mock(async (_x: number, _y: number) => {}),
      down: mock(async (_input: unknown) => {}),
      up: mock(async (_input: unknown) => {}),
      wheel: mock(async (_x: number, _y: number) => {}),
    },
    keyboard: {
      down: mock(async (_key: string) => {}),
      up: mock(async (_key: string) => {}),
    },
  }
}

describe("BrowserInputDispatcher", () => {
  test("clamps mouse coordinates to the viewport", async () => {
    const page = createPage()
    const dispatcher = new BrowserInputDispatcher(page as any, async () => {
      throw new Error("CDP not expected")
    })

    await dispatcher.mouseDown({ x: -20, y: 700, button: "right", clickCount: 2 })

    expect(page.mouse.move).toHaveBeenCalledWith(0, 600)
    expect(page.mouse.down).toHaveBeenCalledWith({ button: "right", clickCount: 2 })
  })

  test("passes wheel deltas and key transitions through Playwright", async () => {
    const page = createPage()
    const dispatcher = new BrowserInputDispatcher(page as any, async () => {
      throw new Error("CDP not expected")
    })

    await dispatcher.mouseWheel({ x: 100, y: 100, deltaX: 4, deltaY: 12 })
    await dispatcher.keyDown({ key: "Control" })
    await dispatcher.keyUp({ key: "Control" })

    expect(page.mouse.wheel).toHaveBeenCalledWith(4, 12)
    expect(page.keyboard.down).toHaveBeenCalledWith("Control")
    expect(page.keyboard.up).toHaveBeenCalledWith("Control")
  })

  test("inserts composed text through CDP Input.insertText", async () => {
    const page = createPage()
    const send = mock(async (_method: string, _params?: Record<string, unknown>) => null)
    const dispatcher = new BrowserInputDispatcher(page as any, async () => ({ send }) as unknown as CDPHandle)

    await dispatcher.insertText("你好")

    expect(send).toHaveBeenCalledWith("Input.insertText", { text: "你好" })
  })
})
