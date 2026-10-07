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
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "Element")
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
  class Target {
    constructor(readonly tag: string) {}
    closest(selector: string) {
      return selector.split(",").some((value) => value.trim() === this.tag) ? this : null
    }
  }
  Object.defineProperty(globalThis, "Element", { configurable: true, writable: true, value: Target })

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
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
    let scrollTop = 0
    const element = {
      scrollHeight: 1000,
      clientHeight: 400,
      calls,
      isConnected: true,
      style: {} as CSSStyleDeclaration,
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const group = listeners.get(type) ?? new Set()
        group.add(listener)
        listeners.set(type, group)
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        listeners.get(type)?.delete(listener)
      },
      dispatchEvent(event: Event) {
        for (const listener of listeners.get(event.type) ?? []) {
          if (typeof listener === "function") listener(event)
          else listener.handleEvent(event)
        }
        return !event.defaultPrevented
      },
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
    Object.setPrototypeOf(element, Target.prototype)
    return element as unknown as HTMLElement & { scrollHeight: number; calls: ScrollToOptions[] }
  }

  const lastObserver = () => FakeResizeObserver.instances.at(-1)

  const restore = () => {
    globalThis.requestAnimationFrame = originalRequest
    globalThis.cancelAnimationFrame = originalCancel
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (originalElement) Object.defineProperty(globalThis, "Element", originalElement)
    else Reflect.deleteProperty(globalThis, "Element")
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
    FakeResizeObserver.instances = []
  }

  const key = (shiftKey = false, target?: string) => {
    const event = new Event("keydown")
    Object.defineProperties(event, {
      key: { value: " " },
      shiftKey: { value: shiftKey },
      target: { value: target ? new Target(target) : undefined },
    })
    return event
  }
  return { flushFrames, tick, makeScroller, lastObserver, key, restore }
}

describe("createAutoScroll", () => {
  test("following never captures or restores a reading owner returned by a caller", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const element = harness.makeScroller()
      let captures = 0
      let autoScroll!: ReturnType<typeof createAutoScroll>
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({
          working: () => false,
          captureReadingAnchor: () => {
            captures++
            return { owner: element, restore() {} }
          },
        })
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
      })
      await harness.tick()
      element.scrollTop = 100
      autoScroll.handleScroll()
      expect(captures).toBe(0)
      expect(autoScroll.readingAnchorOwner()).toBeUndefined()
    } finally {
      dispose()
      harness.restore()
    }
  })
  for (const { intent, working } of [
    { intent: "pointer", working: true },
    { intent: "pointer", working: false },
    { intent: "Shift+Space", working: true },
  ]) {
    test(`the first ${working ? "active" : "idle"} ${intent} movement from following publishes an accepted reading owner`, async () => {
      const harness = createScrollHarness()
      let dispose = () => {}
      try {
        const element = harness.makeScroller()
        let autoScroll!: ReturnType<typeof createAutoScroll>
        createRoot((cleanup) => {
          dispose = cleanup
          autoScroll = createAutoScroll({
            working: () => working,
            captureReadingAnchor: ({ reading }) => (reading ? { owner: element, restore() {} } : undefined),
          })
          autoScroll.scrollRef(element)
        })
        if (!working) {
          await harness.tick()
          await Bun.sleep(350)
        }
        element.scrollTop = 600
        element.dispatchEvent(intent === "pointer" ? new Event("pointerdown") : harness.key(true))
        element.scrollTop = 400
        autoScroll.handleScroll()
        expect(autoScroll.userScrolled()).toBe(true)
        expect(autoScroll.readingAnchorOwner()).toBe(element)
      } finally {
        dispose()
        harness.restore()
      }
    })
  }

  for (const intent of ["Space", "wheel", "pointer"])
    test(`native ${intent} resumption clears the reading closure as well as its published owner`, async () => {
      const harness = createScrollHarness()
      let dispose = () => {}
      try {
        const element = harness.makeScroller()
        let restores = 0
        let autoScroll!: ReturnType<typeof createAutoScroll>
        createRoot((cleanup) => {
          dispose = cleanup
          autoScroll = createAutoScroll({
            working: () => false,
            captureReadingAnchor: ({ reading }) =>
              reading
                ? {
                    owner: element,
                    restore: () => {
                      restores++
                    },
                  }
                : undefined,
          })
          autoScroll.scrollRef(element)
          autoScroll.contentRef(element)
        })
        await harness.tick()
        await Bun.sleep(350)
        autoScroll.handleInteraction()
        element.scrollTop = 400
        autoScroll.handleScroll()
        const movement = new Event("wheel")
        Object.defineProperty(movement, "deltaY", { value: 100 })
        element.dispatchEvent(
          intent === "Space" ? harness.key() : intent === "pointer" ? new Event("pointerdown") : movement,
        )
        if (intent === "pointer") {
          element.scrollTop = 500
          autoScroll.handleScroll()
        }
        element.scrollTop = 600
        autoScroll.handleScroll()
        expect(autoScroll.userScrolled()).toBe(false)
        expect(autoScroll.readingAnchorOwner()).toBeUndefined()
        element.scrollHeight += 100
        harness.lastObserver()!.fire(element)
        expect(restores).toBe(0)
        expect(element.calls).toEqual([{ top: 1100, behavior: "auto" }])
      } finally {
        dispose()
        harness.restore()
      }
    })

  test("Space on an activation control keeps the existing reading intent", () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const element = harness.makeScroller()
      let autoScroll!: ReturnType<typeof createAutoScroll>
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({ working: () => true })
        autoScroll.scrollRef(element)
      })
      element.dispatchEvent(harness.key(true, "button"))
      expect(autoScroll.userScrolled()).toBe(false)
      autoScroll.handleInteraction()
      element.scrollTop = 400
      autoScroll.handleScroll()
      element.dispatchEvent(harness.key(false, "button"))
      element.scrollTop = 600
      autoScroll.handleScroll()
      expect(autoScroll.userScrolled()).toBe(true)
    } finally {
      dispose()
      harness.restore()
    }
  })

  test("rebinding the same viewport preserves reading, and releasing its content clears the owner", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const element = harness.makeScroller()
      const stale = harness.makeScroller()
      let restores = 0
      let autoScroll!: ReturnType<typeof createAutoScroll>
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({
          working: () => true,
          captureReadingAnchor: () => ({
            owner: element,
            restore: () => {
              restores++
            },
          }),
        })
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
      })
      await harness.tick()
      autoScroll.handleInteraction()
      autoScroll.scrollRef(element)
      expect(autoScroll.userScrolled()).toBe(true)
      expect(autoScroll.readingAnchorOwner()).toBe(element)
      autoScroll.contentRef(undefined, stale)
      expect(autoScroll.readingAnchorOwner()).toBe(element)
      autoScroll.contentRef(undefined, element)
      expect(autoScroll.readingAnchorOwner()).toBeUndefined()
      harness.lastObserver()!.fire(element)
      expect(restores).toBe(0)
    } finally {
      dispose()
      harness.restore()
    }
  })

  test("resize releases a removed reading owner and captures its current replacement", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const element = harness.makeScroller()
      const first = harness.makeScroller()
      const second = harness.makeScroller()
      let owner = first
      let restores = 0
      let autoScroll!: ReturnType<typeof createAutoScroll>
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({
          working: () => true,
          captureReadingAnchor: () => ({
            owner,
            restore: () => {
              restores++
            },
          }),
        })
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
      })
      await harness.tick()
      autoScroll.handleInteraction()
      Object.defineProperty(first, "isConnected", { value: false })
      owner = second
      harness.lastObserver()!.fire(element)
      expect(autoScroll.readingAnchorOwner()).toBe(second)
      element.scrollHeight += 100
      harness.lastObserver()!.fire(element)
      expect(restores).toBe(2)
    } finally {
      dispose()
      harness.restore()
    }
  })
  test("accepted native scroll publishes its reading owner without replacing it on layout compensation", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const element = harness.makeScroller()
      const first = harness.makeScroller()
      const second = harness.makeScroller()
      const third = harness.makeScroller()
      let owner = first
      let contentOffset = 100
      let autoScroll!: ReturnType<typeof createAutoScroll>
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({
          working: () => true,
          captureReadingAnchor: () => {
            const offset = contentOffset - element.scrollTop
            return {
              owner,
              restore: () => {
                element.scrollTop = contentOffset - offset
              },
            }
          },
        })
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
      })
      await harness.tick()
      expect(autoScroll.readingAnchorOwner()).toBeUndefined()
      autoScroll.handleInteraction()
      expect(autoScroll.readingAnchorOwner()).toBe(first)
      owner = second
      element.scrollTop = 200
      autoScroll.handleScroll()
      expect(autoScroll.readingAnchorOwner()).toBe(second)
      owner = third
      contentOffset += 100
      element.scrollHeight += 100
      harness.lastObserver()!.fire(element)
      autoScroll.handleScroll()
      expect(autoScroll.readingAnchorOwner()).toBe(second)
      autoScroll.forceScrollToBottom()
      expect(autoScroll.readingAnchorOwner()).toBeUndefined()
    } finally {
      dispose()
      harness.restore()
    }
  })

  test("a resize accepts an already compensated reading offset without adopting a newly visible owner", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const element = harness.makeScroller()
      const accepted = harness.makeScroller()
      const incoming = harness.makeScroller()
      const offsets = new Map([
        [accepted, 100],
        [incoming, 0],
      ])
      let owner = accepted
      let autoScroll!: ReturnType<typeof createAutoScroll>
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({
          working: () => true,
          captureReadingAnchor: () => {
            const captured = owner
            const offset = offsets.get(captured)! - element.scrollTop
            return {
              owner: captured,
              restore: () => {
                element.scrollTop = offsets.get(captured)! - offset
              },
            }
          },
        })
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
      })
      await harness.tick()
      element.scrollTop = 100
      autoScroll.handleInteraction()
      offsets.set(accepted, 200)
      element.scrollHeight += 100
      element.scrollTop = 200
      owner = incoming
      harness.lastObserver()!.fire(element)
      autoScroll.handleScroll()
      expect(autoScroll.readingAnchorOwner()).toBe(accepted)
      offsets.set(accepted, 400)
      offsets.set(incoming, 176)
      element.scrollHeight += 200
      harness.lastObserver()!.fire(element)
      expect(element.scrollTop).toBe(400)
    } finally {
      dispose()
      harness.restore()
    }
  })

  test("manual disclosure at the bottom remains reading through resize and compensated scroll", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const element = harness.makeScroller()
      let restores = 0
      let autoScroll!: ReturnType<typeof createAutoScroll>
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({
          working: () => true,
          captureReadingAnchor: () => ({
            owner: element,
            restore: () => {
              restores++
            },
          }),
        })
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
      })
      await harness.tick()
      harness.flushFrames()
      element.scrollTop = 600
      element.calls.length = 0
      autoScroll.handleInteraction()
      autoScroll.preserveReadingAnchor()
      autoScroll.handleScroll()
      expect(autoScroll.userScrolled()).toBe(true)
      element.scrollHeight += 100
      harness.lastObserver()!.fire(element)
      harness.flushFrames()
      expect(restores).toBe(1)
      expect(element.calls).toEqual([])
    } finally {
      dispose()
      harness.restore()
    }
  })

  test("an explicit latest intent survives delayed hydration and releases on reading input", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const element = harness.makeScroller()
      let autoScroll!: ReturnType<typeof createAutoScroll>
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({ working: () => false, settleMs: 10 })
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
        autoScroll.forceScrollToBottom({ untilInteraction: true })
      })
      await Bun.sleep(30)
      harness.flushFrames()
      element.calls.length = 0
      element.scrollHeight = 2200
      harness.lastObserver()!.fire(element)
      expect(element.calls).toEqual([{ top: 2200, behavior: "auto" }])
      harness.flushFrames()
      expect(element.calls).toEqual([{ top: 2200, behavior: "auto" }])
      autoScroll.handleInteraction()
      element.scrollTop = 300
      element.calls.length = 0
      element.scrollHeight = 3200
      harness.lastObserver()!.fire(element)
      harness.flushFrames()
      expect(element.calls).toEqual([])
      expect(autoScroll.userScrolled()).toBe(true)
    } finally {
      dispose()
      harness.restore()
    }
  })

  test("a latest intent cannot follow growth in a replacement viewport", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const first = harness.makeScroller()
      const second = harness.makeScroller()
      let autoScroll!: ReturnType<typeof createAutoScroll>
      createRoot((cleanup) => {
        dispose = cleanup
        autoScroll = createAutoScroll({ working: () => false, settleMs: 10 })
        autoScroll.scrollRef(first)
        autoScroll.contentRef(first)
      })
      await harness.tick()
      autoScroll.forceScrollToBottom({ untilInteraction: true })
      harness.flushFrames()
      autoScroll.scrollRef(second)
      autoScroll.contentRef(second)
      await Bun.sleep(30)
      second.scrollHeight = 2200
      harness.lastObserver()!.fire(second)
      harness.flushFrames()
      expect(second.calls).toEqual([])
    } finally {
      dispose()
      harness.restore()
    }
  })

  test("reading input cancels a queued latest jump", () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      createRoot((cleanup) => {
        dispose = cleanup
        const element = harness.makeScroller()
        const autoScroll = createAutoScroll({ working: () => false })
        autoScroll.scrollRef(element)
        autoScroll.forceScrollToBottom({ untilInteraction: true })
        autoScroll.handleInteraction()
        harness.flushFrames()
        expect(element.calls).toEqual([])
        expect(autoScroll.userScrolled()).toBe(true)
      })
    } finally {
      dispose()
      harness.restore()
    }
  })

  test("detached layout changes restore the captured reading position through repeated resizes", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const element = harness.makeScroller()
      let contentOffset = 100
      let captures = 0
      let scrollState: ReturnType<typeof createAutoScroll>
      createRoot((done) => {
        dispose = done
        const autoScroll = createAutoScroll({
          working: () => true,
          ...{
            captureReadingAnchor() {
              captures++
              const captured = contentOffset - element.scrollTop
              return {
                owner: element,
                restore: () => {
                  element.scrollTop = contentOffset - captured
                },
              }
            },
          },
        })
        scrollState = autoScroll
        autoScroll.scrollRef(element)
        autoScroll.contentRef(element)
        autoScroll.handleInteraction()
        autoScroll.handleScroll()
      })
      await harness.tick()
      for (const offset of [150, 200, 125]) {
        contentOffset = offset
        element.scrollHeight += 100
        harness.lastObserver()!.fire(element)
        harness.flushFrames()
        expect(contentOffset - element.scrollTop).toBe(100)
        scrollState!.handleScroll()
      }
      expect(captures).toBe(1)
      expect(element.calls).toEqual([])
    } finally {
      dispose()
      harness.restore()
    }
  })

  test("a viewport replacement releases the previous reading anchor", async () => {
    const harness = createScrollHarness()
    let dispose = () => {}
    try {
      const first = harness.makeScroller()
      const second = harness.makeScroller()
      let owner = first
      const restored: HTMLElement[] = []
      let autoScroll: ReturnType<typeof createAutoScroll>
      createRoot((done) => {
        dispose = done
        autoScroll = createAutoScroll({
          working: () => true,
          ...{
            captureReadingAnchor: () => {
              const captured = owner
              return {
                owner: captured,
                restore: () => {
                  restored.push(captured)
                },
              }
            },
          },
        })
        autoScroll.scrollRef(first)
        autoScroll.contentRef(first)
        autoScroll.handleInteraction()
        autoScroll.handleScroll()
      })
      await harness.tick()
      expect(autoScroll!.readingAnchorOwner()).toBe(first)
      first.scrollHeight += 100
      harness.lastObserver()!.fire(first)
      harness.flushFrames()
      expect(restored).toEqual([first])
      owner = second
      autoScroll!.scrollRef(second)
      expect(autoScroll!.readingAnchorOwner()).toBeUndefined()
      autoScroll!.contentRef(second)
      autoScroll!.handleInteraction()
      autoScroll!.scrollRef(undefined, first)
      expect(autoScroll!.readingAnchorOwner()).toBe(second)
      await harness.tick()
      second.scrollHeight += 100
      harness.lastObserver()!.fire(second)
      harness.flushFrames()
      expect(restored).toEqual([first, second])
      dispose()
      dispose = () => {}
      expect(autoScroll!.readingAnchorOwner()).toBeUndefined()
    } finally {
      dispose()
      harness.restore()
    }
  })

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

  test("an attributed stale release does not clear the successor viewport's scroller binding", () => {
    const harness = createScrollHarness()
    try {
      createRoot(() => {
        const autoScroll = createAutoScroll({ working: () => true })
        const first = harness.makeScroller()
        autoScroll.scrollRef(first)
        harness.flushFrames()

        // Keyed session swap: the successor mounts (and binds) before the
        // swapped-out owner's cleanup releases its own element.
        const second = harness.makeScroller()
        autoScroll.scrollRef(second)
        autoScroll.scrollRef(undefined, first)

        // The successor binding survives: a forced pin still scrolls it.
        autoScroll.forceScrollToBottom()
        harness.flushFrames()
        expect(second.calls).toEqual([{ top: 1000, behavior: "auto" }])

        // An unattributed or owning release still clears the binding.
        autoScroll.scrollRef(undefined, second)
        autoScroll.forceScrollToBottom()
        harness.flushFrames()
        expect(second.calls).toEqual([{ top: 1000, behavior: "auto" }])
      })
    } finally {
      harness.restore()
    }
  })

  test("an attributed stale release does not clear the successor content binding", async () => {
    const harness = createScrollHarness()
    try {
      let autoScroll!: ReturnType<typeof createAutoScroll>
      const first = harness.makeScroller()
      const second = harness.makeScroller()
      createRoot(() => {
        autoScroll = createAutoScroll({ working: () => false })
        autoScroll.scrollRef(first)
        autoScroll.contentRef(first)
      })

      // Keyed session swap: successor binds first, then the swapped-out
      // owner's cleanup releases both of its own elements.
      autoScroll.scrollRef(second)
      autoScroll.contentRef(second)
      autoScroll.scrollRef(undefined, first)
      autoScroll.contentRef(undefined, first)

      autoScroll.forceScrollToBottom()
      harness.flushFrames()
      expect(second.calls).toEqual([{ top: 1000, behavior: "auto" }])

      // The successor's content binding survived the stale release: growth
      // on it still re-pins through the ResizeObserver while the forced
      // settle window is open. A cleared binding would produce no scroll.
      await harness.tick()
      second.scrollHeight = 2200
      harness.lastObserver()!.fire(second)
      harness.flushFrames()
      expect(second.calls).toEqual([
        { top: 1000, behavior: "auto" },
        { top: 2200, behavior: "auto" },
      ])
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
