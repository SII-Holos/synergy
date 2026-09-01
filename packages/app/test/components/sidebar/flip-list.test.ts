import { describe, expect, test } from "bun:test"
import { createFlipRunner } from "../../../src/components/sidebar/flip-list-model"

class FakeRow {
  dataset: Record<string, string> = {}
  top = 0
  animated: Array<{ keyframes: Keyframe[]; options?: KeyframeAnimationOptions }> = []

  constructor(id: string, top: number) {
    this.dataset.sessionId = id
    this.top = top
  }

  getBoundingClientRect() {
    return { top: this.top } as DOMRect
  }

  getAnimations() {
    return []
  }

  animate(keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
    this.animated.push({ keyframes, options })
    return {} as unknown as Animation
  }
}

function makeContainer(rows: FakeRow[]) {
  return {
    querySelectorAll: () => rows as unknown as NodeListOf<HTMLElement>,
  } as unknown as HTMLDivElement
}

function animationKinds(row: FakeRow) {
  return row.animated.map(({ options }) => options?.easing)
}

describe("createFlipRunner baseline behavior", () => {
  test("skips the pre-ref pass so the first real snapshot is the baseline", () => {
    const runner = createFlipRunner({ reduceMotion: false })
    const rows = [new FakeRow("a", 0), new FakeRow("b", 40)]

    // The owning render effect fires before the container ref is assigned.
    runner(undefined)

    // First real snapshot establishes the baseline: nothing animates yet.
    runner(makeContainer(rows))
    expect(rows.flatMap(animationKinds)).toEqual([])

    // An identical refresh stays inert — rows must not replay the entrance
    // animation like they did when the pre-ref pass polluted the baseline.
    runner(makeContainer(rows))
    expect(rows.flatMap(animationKinds)).toEqual([])
  })

  test("only rows absent from the baseline play the entrance animation", () => {
    const runner = createFlipRunner({ reduceMotion: false })
    const a = new FakeRow("a", 0)
    const b = new FakeRow("b", 40)
    runner(undefined)
    runner(makeContainer([a]))

    // The next change adds a genuinely new row.
    runner(makeContainer([a, b]))

    expect(animationKinds(b)).toContain("cubic-bezier(0.05, 0.7, 0.1, 1)")
    expect(a.animated).toEqual([])
  })

  test("repositions rows whose measured top changed", () => {
    const runner = createFlipRunner({ reduceMotion: false })
    const a = new FakeRow("a", 0)
    const b = new FakeRow("b", 40)
    runner(undefined)
    runner(makeContainer([a, b]))

    b.top = 100
    runner(makeContainer([a, b]))

    expect(animationKinds(b)).toContain("cubic-bezier(0.2, 0, 0, 1)")
    expect(a.animated).toEqual([])
  })

  test("reduced motion suppresses all animations but keeps tracking positions", () => {
    const runner = createFlipRunner({ reduceMotion: true })
    const a = new FakeRow("a", 0)
    runner(undefined)
    runner(makeContainer([a]))
    runner(makeContainer([a]))
    expect(a.animated).toEqual([])
  })
})
