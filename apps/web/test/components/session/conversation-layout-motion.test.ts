import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { createRoot } from "solid-js"
import { createConversationLayoutMotion } from "../../../src/components/session/conversation-layout-motion"

const cleanups: Array<() => void> = []
let reduced: boolean
let preference: MediaQueryList
let restoreMedia: () => void

beforeEach(() => {
  reduced = false
  preference = window.matchMedia("(prefers-reduced-motion: reduce)")
  Object.defineProperty(preference, "matches", { configurable: true, get: () => reduced })
  const media = spyOn(globalThis, "matchMedia").mockReturnValue(preference)
  restoreMedia = () => media.mockRestore()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  restoreMedia()
})

function fixture(connected = true) {
  const scroll = document.createElement("div")
  const container = document.createElement("div")
  scroll.append(container)
  if (connected) document.body.append(scroll)
  let dispose = () => {}
  const motion = createRoot((rootDispose) => {
    dispose = rootDispose
    return createConversationLayoutMotion(() => container)
  })
  const cleanup = () => {
    dispose()
    scroll.remove()
  }
  cleanups.push(cleanup)
  const row = (key: string, initialTop: number) => {
    let top = initialTop
    const element = document.createElement("div")
    const content = document.createElement("p")
    content.dataset.displayRow = key
    content.textContent = key
    element.append(content)
    container.append(element)
    // happyDOM has no layout or WAAPI engine; only these browser boundaries are controlled.
    element.getBoundingClientRect = () => new DOMRect(0, top - scroll.scrollTop, 700, 40)
    const animations: Array<{
      keyframes: Keyframe[] | PropertyIndexedKeyframes | null
      options: number | KeyframeAnimationOptions | undefined
      cancel: ReturnType<typeof mock<() => void>>
      onfinish: (() => void) | null
    }> = []
    element.animate = (keyframes, options) => {
      const animation = { keyframes, options, cancel: mock(() => {}), onfinish: null as (() => void) | null }
      animations.push(animation)
      return animation as unknown as Animation
    }
    return { element, animations, move: (value: number) => (top = value) }
  }
  return { scroll, container, motion, row, dispose: cleanup }
}

test("commits the reading anchor before moving retained rows, without animating canonical geometry", async () => {
  const view = fixture()
  view.scroll.scrollTop = 300
  const anchor = view.row("reading", 500)
  const following = view.row("following", 600)
  view.container.style.setProperty("--motion-duration-base", "0.24s")
  view.container.style.setProperty("--motion-ease-standard", "linear")
  const before = anchor.element.getBoundingClientRect().top
  const measure = mock(() => {
    view.scroll.scrollTop += 120
  })
  const commit = view.motion.capture(measure)
  anchor.move(620)
  following.move(800)
  expect(measure).not.toHaveBeenCalled()
  commit()
  await Promise.resolve()

  expect(measure).toHaveBeenCalledTimes(1)
  expect(view.scroll.scrollTop).toBe(420)
  expect(anchor.element.getBoundingClientRect().top).toBe(before)
  expect(anchor.animations).toHaveLength(0)
  expect(following.animations).toHaveLength(1)
  expect(following.animations[0].keyframes).toEqual([
    { transform: "translateY(-80px)" },
    { transform: "translateY(0)" },
  ])
  expect(following.animations[0].options).toMatchObject({ duration: 240, easing: "linear", fill: "both" })
  expect(following.element.hasAttribute("data-layout-changing")).toBe(true)
  expect(following.element.getBoundingClientRect().height).toBe(40)
})

test("disconnected rows still commit measurements but never start presentation motion", async () => {
  const view = fixture(false)
  const retained = view.row("retained", 100)
  const measure = mock(() => {})
  const commit = view.motion.capture(measure)
  retained.move(240)
  commit()
  await Promise.resolve()

  expect(retained.element.isConnected).toBe(false)
  expect(measure).toHaveBeenCalledTimes(1)
  expect(retained.animations).toHaveLength(0)
  expect(retained.element.hasAttribute("data-layout-changing")).toBe(false)
})

test("new rows and unchanged or subpixel retained rows do not replay movement", async () => {
  const view = fixture()
  const stable = view.row("stable", 100)
  const small = view.row("small", 200)
  const commit = view.motion.capture(() => {})
  small.move(201)
  const arriving = view.row("arriving", 300)
  arriving.move(400)
  commit()
  await Promise.resolve()

  for (const row of [stable, small, arriving]) {
    expect(row.animations).toHaveLength(0)
    expect(row.element.hasAttribute("data-layout-changing")).toBe(false)
  }
})

test("reversing a layout change cancels the preceding transform and uses the latest committed positions", async () => {
  const view = fixture()
  const row = view.row("retained", 100)
  const first = view.motion.capture(() => {})
  row.move(220)
  first()
  await Promise.resolve()
  expect(row.animations).toHaveLength(1)
  const previous = row.animations[0]

  const superseded = mock(() => {})
  const stale = view.motion.capture(superseded)
  const measure = mock(() => {})
  const latest = view.motion.capture(measure)
  row.move(80)
  stale()
  latest()
  await Promise.resolve()

  expect(superseded).not.toHaveBeenCalled()
  expect(measure).toHaveBeenCalledTimes(1)
  expect(previous.cancel).toHaveBeenCalledTimes(1)
  expect(previous.onfinish).toBeNull()
  expect(row.animations).toHaveLength(2)
  expect(row.animations[1].keyframes).toEqual([{ transform: "translateY(140px)" }, { transform: "translateY(0)" }])
  expect(row.element.hasAttribute("data-layout-changing")).toBe(true)
})

test("reading interruption cancels running motion and rejects a queued anchor correction", async () => {
  const view = fixture()
  const row = view.row("retained", 100)
  const first = view.motion.capture(() => {})
  row.move(200)
  first()
  await Promise.resolve()
  const measure = mock(() => {
    view.scroll.scrollTop = 0
  })
  const commit = view.motion.capture(measure)
  row.move(300)
  commit()
  view.motion.interrupt()
  view.scroll.scrollTop = 75
  await Promise.resolve()

  expect(measure).not.toHaveBeenCalled()
  expect(view.scroll.scrollTop).toBe(75)
  expect(row.animations).toHaveLength(1)
  expect(row.animations[0].cancel).toHaveBeenCalledTimes(1)
  expect(row.element.hasAttribute("data-layout-changing")).toBe(false)
})

test("disposing the Solid owner cancels active motion and prevents a late reading-anchor write", async () => {
  const view = fixture()
  const row = view.row("retained", 100)
  const first = view.motion.capture(() => {})
  row.move(200)
  first()
  await Promise.resolve()
  const measure = mock(() => {
    view.scroll.scrollTop = 0
  })
  const commit = view.motion.capture(measure)
  row.move(300)
  view.scroll.scrollTop = 90
  commit()
  view.dispose()
  await Promise.resolve()

  expect(measure).not.toHaveBeenCalled()
  expect(view.scroll.scrollTop).toBe(90)
  expect(row.animations).toHaveLength(1)
  expect(row.animations[0].cancel).toHaveBeenCalledTimes(1)
  expect(row.animations[0].onfinish).toBeNull()
  expect(row.element.hasAttribute("data-layout-changing")).toBe(false)
})

test("reduced-motion changes settle current movement while new measurements still preserve layout", async () => {
  const view = fixture()
  const row = view.row("retained", 100)
  const first = view.motion.capture(() => {})
  row.move(200)
  first()
  await Promise.resolve()
  reduced = true
  preference.dispatchEvent(new Event("change"))
  expect(row.animations[0].cancel).toHaveBeenCalledTimes(1)
  expect(row.element.hasAttribute("data-layout-changing")).toBe(false)

  const measure = mock(() => {})
  const commit = view.motion.capture(measure)
  row.move(300)
  commit()
  await Promise.resolve()
  expect(measure).toHaveBeenCalledTimes(1)
  expect(row.animations).toHaveLength(1)

  reduced = false
  preference.dispatchEvent(new Event("change"))
  const resume = view.motion.capture(() => {})
  row.move(400)
  resume()
  await Promise.resolve()
  expect(row.animations).toHaveLength(2)
})

test("releasing one row and finishing another removes only their own presentation transforms", async () => {
  const view = fixture()
  const first = view.row("first", 100)
  const second = view.row("second", 200)
  const commit = view.motion.capture(() => {})
  first.move(200)
  second.move(300)
  commit()
  await Promise.resolve()

  view.motion.release("first")
  view.motion.release("first")
  expect(first.animations[0].cancel).toHaveBeenCalledTimes(1)
  expect(first.element.hasAttribute("data-layout-changing")).toBe(false)
  expect(second.animations[0].cancel).not.toHaveBeenCalled()
  expect(second.element.hasAttribute("data-layout-changing")).toBe(true)
  second.animations[0].onfinish?.()
  expect(second.animations[0].cancel).toHaveBeenCalledTimes(1)
  expect(second.animations[0].onfinish).toBeNull()
  expect(second.element.hasAttribute("data-layout-changing")).toBe(false)
})
