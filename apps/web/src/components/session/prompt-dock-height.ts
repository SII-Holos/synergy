import { createEffect, createSignal, onCleanup } from "solid-js"
import { makeResizeObserver } from "@solid-primitives/resize-observer"

/**
 * Reports the composer dock's full layout height, including padding and borders.
 * The dock element mounts through the async plugin-shell swap, so the observed
 * target must be a signal: a bare variable is read once at setup, the observer
 * goes stale after the shell swap, `--prompt-height` stays unset, and overlays
 * such as the scroll-to-bottom button fall back to an offset the dock covers.
 */
export function createPromptDockHeight(onHeight: (height: number) => void) {
  const [dock, setDock] = createSignal<HTMLDivElement | undefined>()
  const { observe, unobserve } = makeResizeObserver(
    (entries) => {
      for (const entry of entries) onHeight(Math.ceil(entry.target.getBoundingClientRect().height))
    },
    { box: "border-box" },
  )
  createEffect(() => {
    const element = dock()
    if (!element) return
    observe(element)
    onCleanup(() => unobserve(element))
  })
  return {
    mount: (element: HTMLDivElement | undefined) => setDock(element),
  }
}
