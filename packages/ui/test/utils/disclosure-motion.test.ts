import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createDisclosureMotion } from "../../src/utils/disclosure-motion"

function fixture(reduced = false) {
  const dom = new JSDOM("<!doctype html><div><button>Inspect evidence</button></div>")
  const element = dom.window.document.querySelector("div")! as unknown as HTMLElement
  Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => ({ height: 28 }) })
  const animations: { finish: () => void; cancelled: boolean; frames: Keyframe[]; duration: number }[] = []
  element.animate = (frames, options) => {
    let finish: (() => void) | undefined
    let playState = "running"
    const record = {
      finish: () => {
        playState = "finished"
        finish?.()
      },
      cancelled: false,
      frames: frames as Keyframe[],
      duration: typeof options === "object" ? Number(options.duration) : 0,
    }
    animations.push(record)
    return {
      get playState() {
        return playState
      },
      set onfinish(value: (() => void) | undefined) {
        finish = value
      },
      cancel: () => {
        playState = "idle"
        record.cancelled = true
      },
      finished: Promise.resolve(),
    } as unknown as Animation
  }
  const listeners = new Set<() => void>()
  const media = {
    matches: reduced,
    addEventListener(_event: string, listener: () => void) {
      listeners.add(listener)
    },
    removeEventListener(_event: string, listener: () => void) {
      listeners.delete(listener)
    },
  }
  dom.window.matchMedia = (() => media) as unknown as typeof dom.window.matchMedia
  const motion = createDisclosureMotion(element)
  return {
    dom,
    element,
    animations,
    motion,
    listeners,
    reduce: () => {
      media.matches = true
      for (const listener of listeners) listener()
    },
  }
}

test("a disclosure group measures every target before starting any of its animations", async () => {
  const items = Array.from({ length: 3 }, () => fixture())
  let started = 0
  try {
    for (const { element, motion } of items) {
      const animate = element.animate
      element.animate = (...args) => {
        started++
        return animate(...args)
      }
      Object.defineProperty(element, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          expect(started).toBe(0)
          return { height: 28 }
        },
      })
      motion.setVisible(false)
      await Promise.resolve()
    }
    for (const { motion } of items) motion.setVisible(true, true)
    await Promise.resolve()
    expect(started).toBe(3)
    for (const { element, animations } of items) {
      expect(animations[0].frames[1].height).toBe("28px")
      animations[0].finish()
      expect(element.hidden).toBe(false)
    }
  } finally {
    for (const { motion, dom } of items) {
      motion.dispose()
      dom.window.close()
    }
  }
})

test("coalesced open and close do not paint an uncommitted entrance", async () => {
  const { dom, element, animations, motion } = fixture()
  motion.setVisible(false)
  motion.setVisible(true, true)
  motion.setVisible(false, true)
  await Promise.resolve()
  expect(element.hidden).toBe(true)
  expect(animations).toHaveLength(0)
  motion.dispose()
  dom.window.close()
})

test("coalesced reversal continues an already painted entrance", async () => {
  const { dom, element, animations, motion } = fixture()
  motion.setVisible(false)
  motion.setVisible(true, true)
  await Promise.resolve()
  motion.setVisible(false, true)
  motion.setVisible(true, true)
  await Promise.resolve()
  expect(animations).toHaveLength(1)
  expect(animations[0].cancelled).toBe(false)
  animations[0].finish()
  expect(element.hidden).toBe(false)
  expect(element.inert).toBe(false)
  expect(element.hasAttribute("data-motion-changing")).toBe(false)
  motion.dispose()
  dom.window.close()
})

test("a finished entrance settles when a queued reversal returns to its target", async () => {
  const { dom, element, animations, motion } = fixture()
  motion.setVisible(false)
  motion.setVisible(true, true)
  await Promise.resolve()
  motion.setVisible(false, true)
  animations[0].finish()
  expect(element.hasAttribute("data-motion-changing")).toBe(true)
  motion.setVisible(true, true)
  await Promise.resolve()
  expect(animations).toHaveLength(1)
  expect(animations[0].cancelled).toBe(true)
  expect(element.hidden).toBe(false)
  expect(element.inert).toBe(false)
  expect(element.hasAttribute("data-motion-changing")).toBe(false)
  motion.dispose()
  dom.window.close()
})

test("a stale callback cannot reactivate disposed motion", async () => {
  const { dom, element, animations, motion, listeners } = fixture()
  motion.setVisible(false)
  motion.dispose()
  motion.setVisible(true, true)
  await Promise.resolve()
  expect(element.hidden).toBe(true)
  expect(animations).toHaveLength(0)
  expect(listeners.size).toBe(0)
  dom.window.close()
})

test("disposal and reduced motion release queued measurements before they touch their target", async () => {
  for (const dispose of [true, false]) {
    const { dom, element, animations, motion, reduce, listeners } = fixture()
    motion.setVisible(true)
    motion.setVisible(false, true)
    Object.defineProperty(element, "getBoundingClientRect", {
      value() {
        throw new Error("Released preparation cannot measure its target")
      },
    })
    if (dispose) {
      element.remove()
      motion.dispose()
    } else reduce()
    await Promise.resolve()
    expect(animations).toHaveLength(0)
    if (!dispose) expect(element.hidden).toBe(true)
    motion.dispose()
    expect(listeners.size).toBe(0)
    dom.window.close()
  }
})

test("restored content stays static and a live receipt grants only an opacity entrance", async () => {
  const { dom, element, animations, motion } = fixture()
  motion.dispose()
  const content = createDisclosureMotion(element, true)
  content.setVisible(false, true)
  await Promise.resolve()
  content.setVisible(true, true)
  await Promise.resolve()
  expect(animations).toHaveLength(0)
  content.setVisible(false)
  await Promise.resolve()
  content.setVisible(true, true, true)
  await Promise.resolve()
  expect(animations).toHaveLength(1)
  expect(animations[0].frames).toEqual([{ opacity: 0.65 }, { opacity: 1 }])
  content.dispose()
  dom.window.close()
})

test("changing reduced motion settles an active disclosure and disposes its listener", async () => {
  const { dom, element, animations, motion, reduce, listeners } = fixture()
  motion.setVisible(true)
  await Promise.resolve()
  motion.setVisible(false, true)
  await Promise.resolve()
  reduce()
  expect(element.hidden).toBe(true)
  expect(animations[0].cancelled).toBe(true)
  expect(element.hasAttribute("data-motion-changing")).toBe(false)
  motion.dispose()
  expect(listeners.size).toBe(0)
  dom.window.close()
})

test("settled disclosures and opacity transitions work without measuring their layout box", async () => {
  const { dom, element, motion } = fixture()
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      throw new Error("A settled disclosure does not need a layout measurement")
    },
  })
  motion.setVisible(true)
  await Promise.resolve()
  motion.setVisible(false)
  await Promise.resolve()
  expect(element.hidden).toBe(true)
  motion.dispose()
  element.hidden = false
  const appearance = createDisclosureMotion(element, true)
  appearance.setVisible(true, true, true)
  await Promise.resolve()
  appearance.dispose()
  const opacity = createDisclosureMotion(element, true, undefined, false)
  opacity.setVisible(true, true, true)
  await Promise.resolve()
  expect(element.hidden).toBe(false)
  opacity.setVisible(false, true)
  await Promise.resolve()
  expect(element.inert).toBe(true)
  opacity.dispose()
  dom.window.close()
})

test("ordinary updates do not replay an appearance and collected tools leave before becoming hidden", async () => {
  const { dom, element, animations, motion } = fixture()
  motion.setVisible(true, true, true)
  await Promise.resolve()
  expect(animations).toHaveLength(1)
  for (let n = 0; n < 20; n++) motion.setVisible(true, true)
  await Promise.resolve()
  expect(animations).toHaveLength(1)
  motion.setVisible(false, true)
  await Promise.resolve()
  expect(element.hidden).toBe(false)
  expect(element.inert).toBe(true)
  expect(element.getAttribute("aria-hidden")).toBe("true")
  animations.at(-1)!.finish()
  expect(element.hidden).toBe(true)
  motion.dispose()
  dom.window.close()
})

test("reopening interrupts collection and a stale finish cannot hide the selected content", async () => {
  const { dom, element, animations, motion } = fixture()
  motion.setVisible(true)
  await Promise.resolve()
  expect(animations).toHaveLength(0)
  motion.setVisible(false, true)
  await Promise.resolve()
  const leaving = animations.at(-1)!
  motion.setVisible(true, true)
  await Promise.resolve()
  expect(leaving.cancelled).toBe(true)
  leaving.finish()
  expect(element.hidden).toBe(false)
  expect(element.inert).toBe(false)
  animations.at(-1)!.finish()
  expect(element.style.height).toBe("")
  expect(element.hasAttribute("data-motion-exiting")).toBe(false)
  motion.dispose()
  dom.window.close()
})

test("reversing an active disclosure begins at its painted opacity", async () => {
  const { dom, element, animations, motion } = fixture()
  motion.setVisible(true)
  await Promise.resolve()
  motion.setVisible(false, true)
  await Promise.resolve()
  element.style.opacity = "0.42"
  motion.setVisible(true, true)
  await Promise.resolve()
  expect(Number(animations.at(-1)!.frames[0].opacity)).toBeCloseTo(0.42)
  motion.dispose()
  dom.window.close()
})

test("reduced motion and detached reading settle without space animations", async () => {
  for (const reduced of [true, false]) {
    const { dom, element, animations, motion } = fixture(reduced)
    motion.setVisible(true, !reduced, false)
    await Promise.resolve()
    motion.setVisible(false, false)
    await Promise.resolve()
    expect(element.hidden).toBe(true)
    expect(animations).toHaveLength(0)
    motion.dispose()
    dom.window.close()
  }
})
