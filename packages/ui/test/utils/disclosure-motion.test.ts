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
    const record = {
      finish: () => finish?.(),
      cancelled: false,
      frames: frames as Keyframe[],
      duration: typeof options === "object" ? Number(options.duration) : 0,
    }
    animations.push(record)
    return {
      set onfinish(value: (() => void) | undefined) {
        finish = value
      },
      cancel: () => {
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

test("restored content stays static and a live receipt grants only an opacity entrance", () => {
  const { dom, element, animations, motion } = fixture()
  motion.dispose()
  const content = createDisclosureMotion(element, true)
  content.setVisible(false, true)
  content.setVisible(true, true)
  expect(animations).toHaveLength(0)
  content.setVisible(false)
  content.setVisible(true, true, true)
  expect(animations).toHaveLength(1)
  expect(animations[0].frames).toEqual([{ opacity: 0.65 }, { opacity: 1 }])
  content.dispose()
  dom.window.close()
})

test("changing reduced motion settles an active disclosure and disposes its listener", () => {
  const { dom, element, animations, motion, reduce, listeners } = fixture()
  motion.setVisible(true)
  motion.setVisible(false, true)
  reduce()
  expect(element.hidden).toBe(true)
  expect(animations[0].cancelled).toBe(true)
  expect(element.hasAttribute("data-motion-changing")).toBe(false)
  motion.dispose()
  expect(listeners.size).toBe(0)
  dom.window.close()
})

test("settled disclosures and opacity transitions work without measuring their layout box", () => {
  const { dom, element, motion } = fixture()
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      throw new Error("A settled disclosure does not need a layout measurement")
    },
  })
  motion.setVisible(true)
  motion.setVisible(false)
  expect(element.hidden).toBe(true)
  motion.dispose()
  element.hidden = false
  const appearance = createDisclosureMotion(element, true)
  appearance.setVisible(true, true, true)
  appearance.dispose()
  const opacity = createDisclosureMotion(element, true, undefined, false)
  opacity.setVisible(true, true, true)
  expect(element.hidden).toBe(false)
  opacity.setVisible(false, true)
  expect(element.inert).toBe(true)
  opacity.dispose()
  dom.window.close()
})

test("ordinary updates do not replay an appearance and collected tools leave before becoming hidden", () => {
  const { dom, element, animations, motion } = fixture()
  motion.setVisible(true, true, true)
  expect(animations).toHaveLength(1)
  for (let n = 0; n < 20; n++) motion.setVisible(true, true)
  expect(animations).toHaveLength(1)
  motion.setVisible(false, true)
  expect(element.hidden).toBe(false)
  expect(element.inert).toBe(true)
  expect(element.getAttribute("aria-hidden")).toBe("true")
  animations.at(-1)!.finish()
  expect(element.hidden).toBe(true)
  motion.dispose()
  dom.window.close()
})

test("reopening interrupts collection and a stale finish cannot hide the selected content", () => {
  const { dom, element, animations, motion } = fixture()
  motion.setVisible(true)
  expect(animations).toHaveLength(0)
  motion.setVisible(false, true)
  const leaving = animations.at(-1)!
  motion.setVisible(true, true)
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

test("reversing an active disclosure begins at its painted opacity", () => {
  const { dom, element, animations, motion } = fixture()
  motion.setVisible(true)
  motion.setVisible(false, true)
  element.style.opacity = "0.42"
  motion.setVisible(true, true)
  expect(Number(animations.at(-1)!.frames[0].opacity)).toBeCloseTo(0.42)
  motion.dispose()
  dom.window.close()
})

test("reduced motion and detached reading settle without space animations", () => {
  for (const reduced of [true, false]) {
    const { dom, element, animations, motion } = fixture(reduced)
    motion.setVisible(true, !reduced, false)
    motion.setVisible(false, false)
    expect(element.hidden).toBe(true)
    expect(animations).toHaveLength(0)
    motion.dispose()
    dom.window.close()
  }
})
