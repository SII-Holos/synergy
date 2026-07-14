import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createAutoScroll } from "./create-auto-scroll"

describe("createAutoScroll", () => {
  test("coalesces repeated stream growth into one scroll per frame", () => {
    const originalRequest = globalThis.requestAnimationFrame
    const originalCancel = globalThis.cancelAnimationFrame
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    let frame: FrameRequestCallback | undefined
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
      },
    })

    const calls: ScrollToOptions[] = []
    let scrollTop = 0
    const element = {
      scrollHeight: 1000,
      clientHeight: 400,
      get scrollTop() {
        return scrollTop
      },
      set scrollTop(value: number) {
        scrollTop = value
      },
      style: {},
      addEventListener() {},
      removeEventListener() {},
      scrollTo(options: ScrollToOptions) {
        calls.push(options)
        scrollTop = Number(options.top ?? scrollTop)
      },
    } as unknown as HTMLElement

    try {
      createRoot((dispose) => {
        const autoScroll = createAutoScroll({ working: () => true })
        autoScroll.scrollRef(element)

        autoScroll.scrollToBottom()
        autoScroll.scrollToBottom()

        expect(calls).toHaveLength(0)
        frame?.(16)
        expect(calls).toEqual([{ top: 1000, behavior: "auto" }])
        dispose()
      })
    } finally {
      globalThis.requestAnimationFrame = originalRequest
      globalThis.cancelAnimationFrame = originalCancel
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})
