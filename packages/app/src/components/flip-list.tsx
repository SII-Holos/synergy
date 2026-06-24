import { createEffect, on, onCleanup, type JSX } from "solid-js"

/**
 * Wraps a session list container with FLIP animation for position changes.
 *
 * When `entries` changes and `<For>` repositions or recreates session rows,
 * this hook computes the position delta for each `[data-session-id]` element,
 * inverts it with a transform, then animates to the rest position.
 *
 * Features:
 * - 100ms debounce to avoid jitter on rapid updates
 * - New rows get a fade-in + micro-slide-up entrance
 * - Repositioning rows get staggered by 25ms (capped at 150ms total)
 * - Respects `prefers-reduced-motion: reduce`
 *
 * Motions:
 *   Reposition: 250ms, cubic-bezier(0.2, 0, 0, 1) — MD3 standard decelerate
 *   Entrance:   200ms, cubic-bezier(0.05, 0.7, 0.1, 1) — MD3 emphasized
 *   Stagger:    25ms/row, max 150ms total
 *
 * Usage:
 *   <FlipList entries={recentEntries()} class="sb-sessions">
 *     <For each={recentEntries()}>
 *       {(entry) => <button class="sb-session-row" data-session-id={entry.id}>...</button>}
 *     </For>
 *   </FlipList>
 */

const EASING_REPOSITION = "cubic-bezier(0.2, 0, 0, 1)"
const EASING_ENTRANCE = "cubic-bezier(0.05, 0.7, 0.1, 1)"
const DURATION_REPOSITION = 250
const DURATION_ENTRANCE = 200
const STAGGER_MS = 25
const MAX_STAGGER = 150
const DEBOUNCE_MS = 100

export function FlipList(props: { entries: readonly unknown[]; children: JSX.Element; class?: string }) {
  let container: HTMLDivElement | undefined
  let prevPositions: Map<string, number> | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

  const query = (): HTMLElement[] => Array.from(container?.querySelectorAll<HTMLElement>("[data-session-id]") ?? [])

  function runFlip() {
    const el = container
    if (!el || reduceMotion) return

    const hasStored = prevPositions && prevPositions.size > 0

    requestAnimationFrame(() => {
      if (!hasStored) {
        const next = new Map<string, number>()
        for (const row of query()) next.set(row.dataset.sessionId!, row.getBoundingClientRect().top)
        prevPositions = next
        return
      }

      // Cancel any in-flight animation from the previous cycle
      for (const row of query()) {
        if (row.style.transition) {
          row.style.transition = ""
          row.style.transform = ""
          row.style.opacity = ""
        }
      }

      const nextPositions = new Map<string, number>()
      const repositioning: Array<{ el: HTMLElement; delta: number; idx: number }> = []
      const entering: HTMLElement[] = []

      let staggerIdx = 0
      for (const row of query()) {
        const id = row.dataset.sessionId!
        const currentY = row.getBoundingClientRect().top
        const prevY = prevPositions!.get(id)

        if (prevY === undefined) {
          entering.push(row)
        } else if (Math.abs(prevY - currentY) > 0.5) {
          repositioning.push({ el: row, delta: prevY - currentY, idx: staggerIdx++ })
        }
        nextPositions.set(id, currentY)
      }

      prevPositions = nextPositions

      // --- Entrance: fade in + slide up ---
      for (const row of entering) {
        row.style.opacity = "0"
        row.style.transform = "translateY(6px)"
        row.style.transition = "none"
        void row.offsetHeight // force reflow
        row.style.transition = [
          `opacity ${DURATION_ENTRANCE}ms ${EASING_ENTRANCE}`,
          `transform ${DURATION_ENTRANCE}ms ${EASING_ENTRANCE}`,
        ].join(", ")
        row.style.opacity = "1"
        row.style.transform = "translateY(0)"
        row.addEventListener(
          "transitionend",
          () => {
            row.style.transition = ""
            row.style.opacity = ""
            row.style.transform = ""
          },
          { once: true },
        )
      }

      if (repositioning.length === 0) return

      // --- Repositioning: FLIP with stagger ---
      const staggerDelay = Math.min(STAGGER_MS, MAX_STAGGER / Math.max(1, repositioning.length))

      // Invert: pull elements back to their old positions
      for (const { el, delta } of repositioning) {
        el.style.transform = `translateY(${delta}px)`
      }

      // Play: animate to rest position with per-row stagger
      requestAnimationFrame(() => {
        for (const { el, idx } of repositioning) {
          const delay = idx * staggerDelay
          el.style.transition = `transform ${DURATION_REPOSITION}ms ${EASING_REPOSITION} ${delay}ms`
          el.style.transform = ""
          el.addEventListener(
            "transitionend",
            () => {
              el.style.transition = ""
              el.style.transform = ""
            },
            { once: true },
          )
        }
      })
    })
  }

  createEffect(
    on(
      () => props.entries,
      () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined
          runFlip()
        }, DEBOUNCE_MS)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })

  return (
    <div ref={container!} class={props.class}>
      {props.children}
    </div>
  )
}
