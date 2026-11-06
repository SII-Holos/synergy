export type FlipSnapshot = {
  positions: Map<string, number>
  visible: boolean
}

function visible(container: HTMLElement) {
  return (
    !container.closest('[inert], [aria-hidden="true"]') &&
    container.getClientRects().length > 0 &&
    container.ownerDocument.defaultView!.getComputedStyle(container).visibility !== "hidden"
  )
}

export function createFlipRunner(options: { selector?: string; dataKey?: string; reduceMotion: () => boolean }) {
  const selector = options.selector ?? "[data-session-id]"
  const dataKey = options.dataKey ?? "sessionId"
  const animations = new Set<Animation>()
  const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(selector))
  const cancel = () => {
    for (const animation of animations) {
      animation.onfinish = null
      animation.cancel()
    }
    animations.clear()
  }
  const positions = (container: HTMLElement) => {
    const origin = container.getBoundingClientRect().top
    return new Map(
      rows(container).flatMap((row) => {
        const id = row.dataset[dataKey]
        return id ? [[id, row.getBoundingClientRect().top - origin] as const] : []
      }),
    )
  }

  return {
    capture(container: HTMLElement): FlipSnapshot {
      const snapshot = { positions: positions(container), visible: visible(container) }
      cancel()
      return snapshot
    },
    play(container: HTMLElement, snapshot: FlipSnapshot) {
      if (options.reduceMotion() || !snapshot.visible || !visible(container)) return
      const nextPositions = positions(container)
      const style = container.ownerDocument.defaultView!.getComputedStyle(container)
      const duration = (role: "base" | "fast") => {
        const value = style.getPropertyValue(`--motion-duration-${role}`).trim()
        return value ? parseFloat(value) * (value.endsWith("ms") ? 1 : 1000) : role === "base" ? 180 : 120
      }
      const easing = style.getPropertyValue("--motion-ease-standard").trim() || "cubic-bezier(0.2, 0, 0, 1)"
      for (const row of rows(container)) {
        const id = row.dataset[dataKey]
        if (!id) continue
        const currentY = nextPositions.get(id)
        const previousY = snapshot.positions.get(id)
        if (currentY === undefined) continue
        const entering = previousY === undefined
        const delta = entering ? 4 : previousY - currentY
        if (!entering && Math.abs(delta) <= 0.5) continue
        const animation = row.animate(
          [
            { transform: `translateY(${delta}px)`, ...(entering ? { opacity: 0 } : {}) },
            { transform: "translateY(0)", ...(entering ? { opacity: 1 } : {}) },
          ],
          { duration: duration(entering ? "fast" : "base"), easing },
        )
        animations.add(animation)
        animation.onfinish = () => animations.delete(animation)
      }
    },
    cancel,
  }
}
