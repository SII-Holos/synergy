export function createScrollMotion(target: () => HTMLElement | undefined) {
  let animation: Animation | undefined
  let element: HTMLElement | undefined
  const reduced = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined
  const offset = () => {
    if (!element || !animation) return 0
    return new DOMMatrixReadOnly(getComputedStyle(element).transform).m42
  }
  const cancel = () => {
    if (animation) animation.onfinish = null
    animation?.cancel()
    animation = undefined
  }
  const preference = () => {
    if (reduced?.matches) cancel()
  }
  reduced?.addEventListener?.("change", preference)
  return {
    move(viewport: HTMLElement, top: number, animate: boolean) {
      const next = target()
      const carry = next === element ? offset() : 0
      const previous = viewport.scrollTop
      cancel()
      element = next
      viewport.scrollTo({ top, behavior: "auto" })
      const delta = viewport.scrollTop - previous + carry
      if (!animate || reduced?.matches || !next?.animate || Math.abs(delta) < 0.5) return
      const style = getComputedStyle(next)
      const duration = style.getPropertyValue("--motion-duration-slow").trim()
      animation = next.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
        duration: duration ? parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000) : 240,
        easing: style.getPropertyValue("--motion-ease-standard").trim() || "cubic-bezier(0.2, 0, 0, 1)",
        fill: "both",
      })
      animation.onfinish = cancel
    },
    interrupt(viewport?: HTMLElement) {
      const carry = offset()
      cancel()
      if (viewport && carry) viewport.scrollTop -= carry
    },
    settle: cancel,
    dispose() {
      cancel()
      reduced?.removeEventListener?.("change", preference)
    },
  }
}
