import { createMemo, createRenderEffect, on, onCleanup, onMount, type JSX, type ParentProps } from "solid-js"

const EASING_REPOSITION = "cubic-bezier(0.2, 0, 0, 1)"
const DURATION_REPOSITION = 240

/**
 * 2D FLIP container for kanban panes: whenever the pane-key sequence of
 * `entries` changes, every `[data-pane-key]` descendant that moved (reorder
 * swaps, focus promotion, overflow reflow) animates from its previous
 * position to the new one, respecting prefers-reduced-motion.
 *
 * Measurements are deferred to a requestAnimationFrame: the keyed <For> below
 * commits its DOM moves in a later effect, so measuring synchronously reads
 * the pre-move positions and the animation would be skipped.
 */
export function FlipPanes(
  props: ParentProps<{
    entries: readonly { key: string }[]
    class?: string
    style?: JSX.CSSProperties | (() => JSX.CSSProperties)
    /** Bind the container element (e.g. for measuring during a resize drag). */
    rootRef?: (element: HTMLDivElement) => void
  }>,
) {
  let container: HTMLDivElement | undefined
  let previousPositions: Map<string, { left: number; top: number }> | undefined
  const motionPreference =
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined
  let frame: number | undefined
  const onMotionChange = () => {
    cancelAnimations(query())
    previousPositions = snapshot(query())
  }
  motionPreference?.addEventListener("change", onMotionChange)
  onCleanup(() => {
    motionPreference?.removeEventListener("change", onMotionChange)
    if (frame !== undefined) cancelAnimationFrame(frame)
    cancelAnimations(query())
    container = undefined
  })

  const bindRoot = (element: HTMLDivElement) => {
    container = element
    props.rootRef?.(element)
  }

  const query = () => Array.from(container?.querySelectorAll<HTMLElement>("[data-pane-key]") ?? [])

  function cancelAnimations(rows: HTMLElement[]) {
    for (const row of rows) {
      for (const animation of row.getAnimations()) {
        animation.cancel()
      }
    }
  }

  function snapshot(rows: HTMLElement[]) {
    const next = new Map<string, { left: number; top: number }>()
    for (const row of rows) {
      const key = row.dataset.paneKey
      if (!key) continue
      const rect = row.getBoundingClientRect()
      next.set(key, { left: rect.left, top: rect.top })
    }
    return next
  }

  function runFlip() {
    if (!container) return
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (motionPreference?.matches) {
      previousPositions = snapshot(query())
      return
    }
    const storedPositions = previousPositions
    cancelAnimations(query())
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!container || motionPreference?.matches) return
      const nextPositions = snapshot(query())
      previousPositions = nextPositions
      if (!storedPositions) return

      const moving: Array<{ element: HTMLElement; dx: number; dy: number }> = []
      for (const row of query()) {
        const key = row.dataset.paneKey
        if (!key) continue
        const current = nextPositions.get(key)
        const previous = storedPositions.get(key)
        if (!current || !previous) continue
        const dx = previous.left - current.left
        const dy = previous.top - current.top
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          moving.push({ element: row, dx, dy })
        }
      }
      if (moving.length === 0) return

      for (const { element, dx, dy } of moving) {
        element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
          duration: DURATION_REPOSITION,
          easing: EASING_REPOSITION,
          fill: "backwards",
        })
      }
    })
  }

  // Resolve the style prop explicitly: when a component passes an accessor
  // (e.g. the focus layout's reactive grid-template-columns), call it inside a
  // memo so Solid tracks its signal dependencies and re-applies on change.
  const style = createMemo(() => (typeof props.style === "function" ? props.style() : props.style))

  // Gate the FLIP on the pane-key sequence instead of the entries array
  // identity: nav-store churn recreates the array several times a second
  // while streaming, and measuring getBoundingClientRect on every wave for
  // an unchanged layout is pure waste.
  const signature = createMemo(() => props.entries.map((entry) => entry.key).join("\n"))

  // Refresh the stored positions without animating when the container
  // resizes (window resize, rail drag): the next signature change must not
  // animate from stale coordinates.
  onMount(() => {
    const element = container
    if (!element) return
    previousPositions = snapshot(query())
    const observer = new ResizeObserver(() => {
      cancelAnimations(query())
      previousPositions = snapshot(query())
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  createRenderEffect(on(signature, () => runFlip()))

  return (
    <div ref={bindRoot} class={props.class} style={style()}>
      {props.children}
    </div>
  )
}
