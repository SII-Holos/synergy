import { createRenderEffect, on, type JSX } from "solid-js"

const EASING_REPOSITION = "cubic-bezier(0.2, 0, 0, 1)"
const EASING_ENTRANCE = "cubic-bezier(0.05, 0.7, 0.1, 1)"
const DURATION_REPOSITION = 250
const DURATION_ENTRANCE = 160
const STAGGER_MS = 18
const MAX_STAGGER = 120

export function FlipList(props: { entries: readonly unknown[]; children: JSX.Element; class?: string }) {
  let container: HTMLDivElement | undefined
  let previousPositions: Map<string, number> | undefined
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

  const query = (): HTMLElement[] => Array.from(container?.querySelectorAll<HTMLElement>("[data-session-id]") ?? [])

  function snapshot(rows: HTMLElement[]) {
    const next = new Map<string, number>()
    for (const row of rows) {
      const id = row.dataset.sessionId
      if (!id) continue
      next.set(id, row.getBoundingClientRect().top)
    }
    return next
  }

  function cancelAnimations(rows: HTMLElement[]) {
    for (const row of rows) {
      for (const animation of row.getAnimations()) {
        animation.cancel()
      }
    }
  }

  function runFlip() {
    const rows = query()
    cancelAnimations(rows)
    const nextPositions = snapshot(rows)
    const storedPositions = previousPositions
    previousPositions = nextPositions

    if (!container || reduceMotion || !storedPositions) return

    const repositioning: Array<{ element: HTMLElement; delta: number; index: number }> = []
    const entering: HTMLElement[] = []
    let index = 0

    for (const row of rows) {
      const id = row.dataset.sessionId
      if (!id) continue
      const currentY = nextPositions.get(id)
      const previousY = storedPositions.get(id)
      if (currentY === undefined) continue
      if (previousY === undefined) {
        entering.push(row)
        continue
      }
      const delta = previousY - currentY
      if (Math.abs(delta) > 0.5) {
        repositioning.push({ element: row, delta, index })
        index += 1
      }
    }

    for (const row of entering) {
      row.animate(
        [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: DURATION_ENTRANCE, easing: EASING_ENTRANCE },
      )
    }

    if (repositioning.length === 0) return

    const staggerDelay = Math.min(STAGGER_MS, MAX_STAGGER / Math.max(1, repositioning.length))
    for (const { element, delta, index } of repositioning) {
      element.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
        duration: DURATION_REPOSITION,
        easing: EASING_REPOSITION,
        delay: index * staggerDelay,
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
    <div ref={container!} class={props.class}>
      {props.children}
    </div>
  )
}
