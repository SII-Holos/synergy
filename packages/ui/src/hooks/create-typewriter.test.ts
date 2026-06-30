import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { advanceTypewriterFrame, createTypewriter, type TypewriterFrameState } from "./create-typewriter"

describe("createTypewriter", () => {
  test("shows completed historical text immediately on first mount", () => {
    createRoot((dispose) => {
      const output = createTypewriter({
        source: () => "already complete",
        streaming: () => false,
        completed: () => true,
      })

      expect(output()).toBe("already complete")
      dispose()
    })
  })

  test("does not reveal a large live chunk in a single frame", () => {
    const next = advanceTypewriterFrame({
      state: { revealedLength: 0, fractional: 0 },
      sourceLength: 160,
      elapsedMs: 16,
      streaming: true,
      completed: false,
    })

    expect(next.revealedLength).toBeGreaterThan(0)
    expect(next.revealedLength).toBeLessThan(160)
  })

  test("drains after completion instead of snapping to the full source", () => {
    const live = advanceTypewriterFrame({
      state: { revealedLength: 0, fractional: 0 },
      sourceLength: 160,
      elapsedMs: 16,
      streaming: true,
      completed: false,
    })
    const completed = advanceTypewriterFrame({
      state: live,
      sourceLength: 160,
      elapsedMs: 16,
      streaming: false,
      completed: true,
    })

    expect(completed.revealedLength).toBeGreaterThan(live.revealedLength)
    expect(completed.revealedLength).toBeLessThan(160)
  })

  test("snaps and resets when the source shrinks", () => {
    const state: TypewriterFrameState = {
      revealedLength: 24,
      fractional: 0.5,
    }
    const next = advanceTypewriterFrame({
      state,
      sourceLength: 3,
      elapsedMs: 16,
      streaming: true,
      completed: false,
    })

    expect(next).toEqual({ revealedLength: 3, fractional: 0 })
  })
})
