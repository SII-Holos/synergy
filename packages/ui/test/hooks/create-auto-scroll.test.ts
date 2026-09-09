import { describe, expect, mock, test } from "bun:test"
import * as SolidWeb from "solid-js/web"
import { createRoot, createSignal } from "solid-js"

// The hook's resize wiring is browser-only: the @solid-primitives package
// short-circuits on the server build. Force the client build's flag so the
// ResizeObserver path is exercised.
mock.module("solid-js/web", () => ({ ...SolidWeb, isServer: false }))

import { createAutoScroll } from "../../src/hooks/create-auto-scroll"

type FrameCallback = (time: number) => void

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  constructor(readonly dispatch: (entries: unknown[], observer: FakeResizeObserver) => void) {
    FakeResizeObserver.instances.push(this)
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(element: { scrollHeight: number }): void {
    this.dispatch([{ target: element, contentRect: { width: 800, height: element.scrollHeight } }], this)
  }
}

function createScrollHarness() {
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  const frames = new Map<number, FrameCallback>()
  let nextFrame = 0

  globalThis.requestAnimationFrame = ((callback: FrameCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => frames.delete(id)) as typeof cancelAnimationFrame
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver as unknown as
    | typeof ResizeObserver
    | undefined
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { addEventListener() {}, removeEventListener() {} },
  })

  FakeResizeObserver.instances = []

  const flushFrames = () => {
    while (frames.size > 0) {
      const pending = [...frames.values()]
      frames.clear()
      for (const frame of pending) frame(16)
    }
  }

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const makeScroller = () => {
    const calls: ScrollToOptions[] = []
    let scrollTop = 0
    const element = {
      scrollHeight: 1000,
      clientHeight: 400,
      calls,
      style: {} as CSSStyleDeclaration,
      addEventListener() {},
      removeEventListener() {},
      scrollTo(options: ScrollToOptions) {
        calls.push(options)
        scrollTop = Number(options.top ?? scrollTop)
      },
      get scrollTop() {
        return scrollTop
      },
      set scrollTop(value: number) {
        scrollTop = value
      },
    }
    return element as unknown as HTMLElement & { scrollHeight: number; calls: ScrollToOptions[] }
  }

  const lastObserver = () => FakeResizeObserver.instances.at(-1)

  const restore = () => {
    globalThis.requestAnimationFrame = originalRequest
    globalThis.cancelAnimationFrame = originalCancel
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
    FakeResizeObserver.instances = []
  }

  return { flushFrames, tick, makeScroller, lastObserver, restore }
}

describe("createAutoScroll", () => {
  test("coalesces repeated stream growth into one scroll per frame", () => {
    const harness = createScrollHarness()
    try {
      createRoot(() => {
        const autoScroll = createAutoScroll({ working: () => true })
        const element = harness.makeScroller()
        autoScroll.scrollRef(element)

        autoScroll.scrollToBottom()
        autoScroll.scrollToBottom()

        harness.flushFrames()
        expect(element.calls).toEqual([{ top: 1000, behavior: "auto" }])
      })
    } finally {
      harness.restore()
    }
  })

  test("a forced pin keeps re-pinning through late content growth while the settle window is open", async () => {
    const harness = createScrollHarness()
    try {
      const measures: number[] = []
      const element = harness.makeScroller()
      createRoot(() => {
        const autoScroll = createAutoScroll({ working: () => false, onMeasure: (distance) => measures.push(distance) })
        autoScroll.scrollRef(element)
        autoScroll.forceScrollToBottom()
        autoScroll.contentRef(element)
      })
      harness.flushFrames()
      expect(element.calls).toEqual([{ top: 1000, behavior: "auto" }])

      await harness.tick()
      const observer = harness.lastObserver()
      expect(observer).toBeDefined()

      element.scrollHeight = 2200
      observer!.fire(element)
      harness.flushFrames()

      expect(element.calls).toEqual([
        { top: 1000, behavior: "auto" },
        { top: 2200, behavior: "auto" },
      ])
      expect(measures).toEqual([])
    } finally {
      harness.restore()
    }
  })

  test("growth without scroll events reports the distance so scrolled-up state stays honest", async () => {
    const harness = createScrollHarness()
    try {
      const measures: number[] = []
      const element = harness.makeScroller()
      createRoot(() => {
        const autoScroll = createAutoScroll({ working: () => false, onMeasure: (distance) => measures.push(distance) })
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
      })

      await harness.tick()
      const observer = harness.lastObserver()
      expect(observer).toBeDefined()

      await Bun.sleep(350)
      element.scrollHeight = 1600
      observer!.fire(element)
      harness.flushFrames()

      expect(measures).toEqual([1200])
      expect(element.calls).toEqual([])
    } finally {
      harness.restore()
    }
  })

  test("remounting a scroller drops the previous session's user-scrolled state", () => {
    const harness = createScrollHarness()
    try {
      createRoot(() => {
        const autoScroll = createAutoScroll({ working: () => true })
        const first = harness.makeScroller()
        autoScroll.scrollRef(first)
        autoScroll.forceScrollToBottom()
        harness.flushFrames()

        first.scrollTop = 0
        autoScroll.handleInteraction()
        expect(autoScroll.userScrolled()).toBe(true)

        autoScroll.scrollToBottom()
        harness.flushFrames()
        expect(first.calls).toEqual([{ top: 1000, behavior: "auto" }])

        const second = harness.makeScroller()
        autoScroll.scrollRef(second)
        expect(autoScroll.userScrolled()).toBe(false)

        autoScroll.scrollToBottom()
        harness.flushFrames()
        expect(second.calls).toEqual([{ top: 1000, behavior: "auto" }])
      })
    } finally {
      harness.restore()
    }
  })
})

for (const pending of [false, true]) {
  test(`a remounted hash-target scroller does not inherit ${pending ? "pending" : "settled"} forced scrolling`, async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      let autoScroll!: ReturnType<typeof createAutoScroll>
      const first = harness.makeScroller()
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({ working: () => false })
        autoScroll.scrollRef(first)
        autoScroll.contentRef(first)
      })
      autoScroll.forceScrollToBottom()
      if (!pending) harness.flushFrames()
      const second = harness.makeScroller()
      autoScroll.scrollRef(second)
      autoScroll.contentRef(second)
      second.scrollTop = 200
      await harness.tick()
      harness.lastObserver()!.fire(second)
      harness.flushFrames()
      expect(second.calls).toEqual([])
      expect(second.scrollTop).toBe(200)
    } finally {
      dispose()
      harness.restore()
    }
  })
}

for (const force of [false, true]) {
  test(`work completion ${force ? "preserves the explicit pin" : "does not extend ordinary settling"}`, async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      let setWorking!: (value: boolean) => boolean
      let autoScroll!: ReturnType<typeof createAutoScroll>
      const element = harness.makeScroller()
      createRoot((cleanup) => {
        dispose = cleanup
        const [working, update] = createSignal(true)
        setWorking = update
        autoScroll = createAutoScroll({ working })
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
      })
      await harness.tick()
      harness.flushFrames()
      if (force) autoScroll.forceScrollToBottom()
      harness.flushFrames()
      setWorking(false)
      await Bun.sleep(200)
      element.scrollHeight = 2200
      harness.lastObserver()!.fire(element)
      harness.flushFrames()
      await Bun.sleep(200)
      element.calls.length = 0
      element.scrollHeight = 3200
      harness.lastObserver()!.fire(element)
      harness.flushFrames()
      expect(element.calls.length).toBe(force ? 1 : 0)
    } finally {
      dispose()
      harness.restore()
    }
  })
}
