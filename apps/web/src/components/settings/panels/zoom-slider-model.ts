import { createComputed, createSignal } from "solid-js"

export type ZoomSliderModel = {
  /** Current slider preview factor (may differ from the applied factor mid-drag). */
  preview: () => number
  /** Update the preview while dragging; does not apply anything. */
  setPreview: (factor: number) => void
  /** Commit the factor on pointer release. */
  commit: (factor: number) => void
}

/**
 * Slider state for a zoom that rescales the whole page. Applying zoom on every
 * input event would rescale the settings page under the pointer and shift the
 * slider thumb mid-drag, so the preview stays local while dragging and the
 * factor is committed only on pointer release. When the applied factor changes
 * externally (successful apply or failure re-sync), the preview follows it.
 */
export function createZoomSliderModel(applied: () => number, onCommit: (factor: number) => void): ZoomSliderModel {
  const [preview, setPreview] = createSignal(applied())
  createComputed(() => setPreview(applied()))
  return { preview, setPreview, commit: onCommit }
}
