const EASING_REPOSITION = "cubic-bezier(0.2, 0, 0, 1)"
const EASING_ENTRANCE = "cubic-bezier(0.05, 0.7, 0.1, 1)"
const DURATION_REPOSITION = 250
const DURATION_ENTRANCE = 160
const STAGGER_MS = 18
const MAX_STAGGER = 120

/**
 * Create the FLIP runner owned by a FlipList instance. Returns a function that
 * snapshots row positions on every entries change and animates rows that moved
 * or entered since the previous snapshot.
 */
export function createFlipRunner(options: { selector?: string; dataKey?: string; reduceMotion: boolean }) {
  const selector = options.selector ?? "[data-session-id]"
  const dataKey = options.dataKey ?? "sessionId"
  let previousPositions: Map<string, number> | undefined

  return (container: HTMLDivElement | undefined) => {
    // The owning render effect fires once at mount, before the container ref
    // is assigned. Skipping that pass keeps previousPositions unset, so the
    // first real snapshot becomes the baseline instead of an empty map that
    // would classify every row as "entering" on the next entries change.
    if (!container) return

    const rows = Array.from(container.querySelectorAll<HTMLElement>(selector))
    for (const row of rows) {
      for (const animation of row.getAnimations()) animation.cancel()
    }

    const nextPositions = new Map<string, number>()
    for (const row of rows) {
      const id = row.dataset[dataKey as keyof typeof row.dataset] as string | undefined
      if (!id) continue
      nextPositions.set(id, row.getBoundingClientRect().top)
    }

    const storedPositions = previousPositions
    previousPositions = nextPositions
    if (options.reduceMotion || !storedPositions) return

    const repositioning: Array<{ element: HTMLElement; delta: number; index: number }> = []
    const entering: HTMLElement[] = []
    let index = 0

    for (const row of rows) {
      const id = row.dataset[dataKey as keyof typeof row.dataset] as string | undefined
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
}
