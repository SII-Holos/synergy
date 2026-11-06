import { describe, expect, test } from "bun:test"
import { createFlipRunner } from "../../../src/components/sidebar/flip-list-model"

class FakeAnimation {
  cancelled = false
  onfinish: Animation["onfinish"] = null
  cancel() {
    this.cancelled = true
  }
}

class FakeRow {
  dataset: Record<string, string>
  foreign = new FakeAnimation()
  animated: Array<{ keyframes: Keyframe[]; options?: KeyframeAnimationOptions; animation: FakeAnimation }> = []

  constructor(
    id: string,
    public top: number,
  ) {
    this.dataset = { sessionId: id }
  }

  getBoundingClientRect() {
    return new DOMRect(0, this.top, 200, 40)
  }

  getAnimations() {
    return [this.foreign, ...this.animated.map((entry) => entry.animation)] as unknown as Animation[]
  }

  animate(keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
    const animation = new FakeAnimation()
    this.animated.push({ keyframes, options, animation })
    return animation as unknown as Animation
  }
}

function makeContainer(rows: FakeRow[], top = 0) {
  const element = document.createElement("div")
  element.style.setProperty("--motion-duration-base", "180ms")
  element.style.setProperty("--motion-duration-fast", "120ms")
  element.style.setProperty("--motion-ease-standard", "cubic-bezier(0.2, 0, 0, 1)")
  const geometry = { top }
  element.getBoundingClientRect = () => new DOMRect(0, geometry.top, 200, 200)
  element.querySelectorAll = () => rows as unknown as NodeListOf<HTMLElement>
  element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList
  return { element, geometry }
}

const runner = () => createFlipRunner({ reduceMotion: () => false })

describe("list motion from the current layout", () => {
  test("scrolling or moving the list origin does not reposition its rows", () => {
    const motion = runner()
    const a = new FakeRow("a", 100)
    const b = new FakeRow("b", 140)
    const container = makeContainer([a, b], 100)
    const before = motion.capture(container.element)
    container.geometry.top = -400
    a.top = -400
    b.top = -360
    motion.play(container.element, before)
    expect(a.animated).toEqual([])
    expect(b.animated).toEqual([])
  })

  test("new rows enter while retained rows stay stable", () => {
    const motion = runner()
    const a = new FakeRow("a", 0)
    const b = new FakeRow("b", 40)
    const rows = [a]
    const container = makeContainer(rows)
    const before = motion.capture(container.element)
    rows.push(b)
    motion.play(container.element, before)
    expect(a.animated).toEqual([])
    expect(b.animated[0]?.keyframes[0]?.opacity).toBe(0)
    expect(b.animated[0]?.keyframes.at(-1)?.opacity).toBe(1)
  })

  test("reordering uses heights measured immediately before that change", () => {
    const motion = runner()
    const a = new FakeRow("a", 0)
    const b = new FakeRow("b", 120)
    const container = makeContainer([a, b])
    const before = motion.capture(container.element)
    a.top = 40
    b.top = 0
    motion.play(container.element, before)
    expect(a.animated[0]?.keyframes[0]?.transform).toBe("translateY(-40px)")
    expect(b.animated[0]?.keyframes[0]?.transform).toBe("translateY(120px)")
    expect(a.animated[0]?.options?.delay ?? 0).toBe(0)
    expect(b.animated[0]?.options?.delay ?? 0).toBe(0)
  })

  test("capture and disposal cancel only animations owned by the list", () => {
    const motion = runner()
    const a = new FakeRow("a", 0)
    const container = makeContainer([a])
    const before = motion.capture(container.element)
    a.top = 40
    motion.play(container.element, before)
    const owned = a.animated[0]!.animation
    motion.capture(container.element)
    expect(owned.cancelled).toBe(true)
    expect(a.foreign.cancelled).toBe(false)
    const next = motion.capture(container.element)
    a.top = 80
    motion.play(container.element, next)
    motion.cancel()
    expect(a.animated.at(-1)?.animation.cancelled).toBe(true)
  })

  test("hidden updates do not replay when the list opens", () => {
    const motion = runner()
    const a = new FakeRow("a", 0)
    const rows: FakeRow[] = []
    const container = makeContainer(rows)
    container.element.inert = true
    const before = motion.capture(container.element)
    rows.push(a)
    container.element.inert = false
    motion.play(container.element, before)
    expect(a.animated).toEqual([])
  })

  test("reads the current reduced-motion preference when playing", () => {
    let reduced = false
    const motion = createFlipRunner({ reduceMotion: () => reduced })
    const a = new FakeRow("a", 0)
    const container = makeContainer([a])
    const before = motion.capture(container.element)
    a.top = 40
    reduced = true
    motion.play(container.element, before)
    expect(a.animated).toEqual([])
  })
})
