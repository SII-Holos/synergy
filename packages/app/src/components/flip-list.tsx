import { createEffect, on, type JSX } from "solid-js"

/**
 * Wraps a session list container with FLIP animation for position changes.
 *
 * When `entries` changes and `<For>` repositions or recreates session rows,
 * this hook computes the position delta for each `[data-session-id]` element,
 * inverts it with a transform, then animates to the rest position.
 *
 * Usage:
 *   <FlipList entries={recentEntries()} class="sb-sessions">
 *     <For each={recentEntries()}>
 *       {(entry) => <button class="sb-session-row" data-session-id={entry.id}>...</button>}
 *     </For>
 *   </FlipList>
 */
export function FlipList(props: { entries: readonly unknown[]; children: JSX.Element; class?: string }) {
  let container: HTMLDivElement | undefined
  let prevPositions: Map<string, number> | undefined

  const query = (): HTMLElement[] => Array.from(container?.querySelectorAll<HTMLElement>("[data-session-id]") ?? [])

  createEffect(
    on(
      () => props.entries,
      () => {
        const el = container
        if (!el) return

        const hasStored = prevPositions && prevPositions.size > 0

        requestAnimationFrame(() => {
          if (!hasStored) {
            // First render: store current positions, no animation
            const next = new Map<string, number>()
            for (const row of query()) {
              next.set(row.dataset.sessionId!, row.getBoundingClientRect().top)
            }
            prevPositions = next
            return
          }

          // Subsequent render: compute FLIP animation

          // Cancel any in-flight animation from the previous cycle
          for (const row of query()) {
            if (row.style.transition) {
              row.style.transition = ""
              row.style.transform = ""
            }
          }

          const nextPositions = new Map<string, number>()
          const animating: Array<{ el: HTMLElement; delta: number }> = []

          for (const row of query()) {
            const id = row.dataset.sessionId!
            const currentY = row.getBoundingClientRect().top
            const prevY = prevPositions!.get(id)
            if (prevY !== undefined && Math.abs(prevY - currentY) > 0.5) {
              animating.push({ el: row, delta: prevY - currentY })
            }
            nextPositions.set(id, currentY)
          }

          prevPositions = nextPositions

          if (animating.length === 0) return

          // Phase 1: invert — move elements back to their old positions
          for (const { el, delta } of animating) {
            el.style.transform = `translateY(${delta}px)`
          }

          // Phase 2: play — animate to final position
          requestAnimationFrame(() => {
            for (const { el } of animating) {
              el.style.transition = "transform 300ms cubic-bezier(0.16, 1, 0.3, 1)"
              el.style.transform = ""
              el.addEventListener(
                "transitionend",
                () => {
                  el.style.transition = ""
                },
                { once: true },
              )
            }
          })
        })
      },
      { defer: true },
    ),
  )

  return (
    <div ref={container!} class={props.class}>
      {props.children}
    </div>
  )
}
