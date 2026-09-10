import { createSignal } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"

/**
 * Reports the composer dock's content-box height (ceil'd) whenever it changes.
 * The dock element mounts through the async plugin-shell swap, so the observed
 * target must be a signal: a bare variable is read once at setup, the observer
 * goes stale after the shell swap, `--prompt-height` stays unset, and overlays
 * such as the scroll-to-bottom button fall back to an offset the dock covers.
 */
export function createPromptDockHeight(onHeight: (height: number) => void) {
  const [dock, setDock] = createSignal<HTMLDivElement | undefined>()
  createResizeObserver(dock, ({ height }) => onHeight(Math.ceil(height)))
  return {
    mount: (element: HTMLDivElement | undefined) => setDock(element),
  }
}
