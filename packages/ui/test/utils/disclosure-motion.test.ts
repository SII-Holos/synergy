import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createDisclosureMotion } from "../../src/utils/disclosure-motion"

function fixture(reduced = false) {
  const dom = new JSDOM("<!doctype html><div><button>Inspect evidence</button></div>")
  const element = dom.window.document.querySelector("div")! as unknown as HTMLElement
  Object.defineProperty(element, "getBoundingClientRect", { value: () => ({ height: 28 }) })
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
  dom.window.matchMedia = (() => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof dom.window.matchMedia
  const motion = createDisclosureMotion(element)
  return { dom, element, animations, motion }
}

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
