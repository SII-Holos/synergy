import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
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

  test("snaps after completion instead of draining", () => {
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

    expect(completed).toEqual({ revealedLength: 160, fractional: 0 })
    expect(completed.revealedLength).toBeGreaterThan(live.revealedLength)
  })

  test("snaps active backlog when completion arrives", () => {
    let frame: FrameRequestCallback | undefined
    const requestAnimationFrame = globalThis.requestAnimationFrame
    const cancelAnimationFrame = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }) as typeof globalThis.requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame

    try {
      createRoot((dispose) => {
        const [completed, setCompleted] = createSignal(false)
        const output = createTypewriter({
          source: () => "streamed backlog",
          streaming: () => true,
          completed,
        })

        expect(output()).toBe("")
        setCompleted(true)
        frame?.(performance.now() + 16)
        expect(output()).toBe("streamed backlog")
        dispose()
      })
    } finally {
      globalThis.requestAnimationFrame = requestAnimationFrame
      globalThis.cancelAnimationFrame = cancelAnimationFrame
    }
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
