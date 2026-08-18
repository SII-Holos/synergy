import { createRenderEffect, on, type JSX, type ParentProps } from "solid-js"

const EASING_REPOSITION = "cubic-bezier(0.2, 0, 0, 1)"
const DURATION_REPOSITION = 250
const STAGGER_MS = 18
const MAX_STAGGER = 120

/**
 * 2D FLIP container for kanban panes: whenever `entries` changes, every
 * `[data-pane-key]` descendant that moved (reorder swaps, focus promotion,
 * overflow reflow) animates from its previous position to the new one.
 * Mirrors the sidebar FlipList timing and respects prefers-reduced-motion.
 */
export function FlipPanes(
  props: ParentProps<{
    entries: readonly unknown[]
    class?: string
    style?: JSX.CSSProperties
  }>,
) {
  let container: HTMLDivElement | undefined
  let previousPositions: Map<string, { left: number; top: number }> | undefined
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

  const query = () => Array.from(container?.querySelectorAll<HTMLElement>("[data-pane-key]") ?? [])

  function runFlip() {
    const rows = query()
    if (!container || reduceMotion) return
    const nextPositions = new Map<string, { left: number; top: number }>()
    for (const row of rows) {
      const key = row.dataset.paneKey
      if (!key) continue
      const rect = row.getBoundingClientRect()
      nextPositions.set(key, { left: rect.left, top: rect.top })
    }
    const storedPositions = previousPositions
    previousPositions = nextPositions
    if (!storedPositions) return

    const moving: Array<{ element: HTMLElement; dx: number; dy: number; index: number }> = []
    let index = 0
    for (const row of rows) {
      const key = row.dataset.paneKey
      if (!key) continue
      const current = nextPositions.get(key)
      const previous = storedPositions.get(key)
      if (!current || !previous) continue
      const dx = previous.left - current.left
      const dy = previous.top - current.top
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        moving.push({ element: row, dx, dy, index })
        index += 1
      }
    }
    if (moving.length === 0) return

    const staggerDelay = Math.min(STAGGER_MS, MAX_STAGGER / Math.max(1, moving.length))
    for (const { element, dx, dy, index: i } of moving) {
      element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
        duration: DURATION_REPOSITION,
        easing: EASING_REPOSITION,
        delay: i * staggerDelay,
        fill: "backwards",
      })
    }
  }

  createRenderEffect(
    on(
      () => props.entries,
      () => runFlip(),
    ),
  )

  return (
    <div ref={container!} class={props.class} style={props.style}>
      {props.children}
    </div>
  )
}
