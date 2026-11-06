import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createZoomSliderModel } from "../../../../src/components/settings/panels/zoom-slider-model"

describe("zoom slider model", () => {
  test("initializes the preview from the applied factor", () => {
    createRoot(() => {
      const model = createZoomSliderModel(
        () => 1.75,
        () => {},
      )
      expect(model.preview()).toBe(1.75)
    })
  })

  test("previews locally while dragging and commits exactly once on release", () => {
    createRoot(() => {
      const commits: number[] = []
      const [applied, setApplied] = createSignal(1)
      const model = createZoomSliderModel(applied, (factor) => {
        commits.push(factor)
        setApplied(factor)
      })

      // Dragging updates only the preview; the applied zoom stays unchanged so
      // the page never rescales under the pointer mid-drag.
      model.setPreview(1.5)
      expect(model.preview()).toBe(1.5)
      expect(commits).toEqual([])
      expect(applied()).toBe(1)

      // Pointer release commits the factor exactly once.
      model.commit(1.5)
      expect(commits).toEqual([1.5])
      expect(applied()).toBe(1.5)
    })
  })

  test("setPreview is a no-op for the applied factor", () => {
    createRoot(() => {
      const commits: number[] = []
      const model = createZoomSliderModel(
        () => 1,
        (factor) => commits.push(factor),
      )

      model.setPreview(2)

      expect(commits).toEqual([])
    })
  })
})
