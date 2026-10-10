export function createScrollMotion(target: () => HTMLElement | undefined) {
  let animation: Animation | undefined
  let element: HTMLElement | undefined
  let position: { viewport: HTMLElement; top: number } | undefined
  const reduced = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined
  const offset = () => {
    if (!element || !animation) return 0
    const transform = getComputedStyle(element).transform
    return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42
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
      const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      const clamped =
        animate &&
        next === element &&
        position?.viewport === viewport &&
        position.top > maximum &&
        Math.abs(viewport.scrollTop - maximum) < 1
      const previous = clamped ? position!.top : viewport.scrollTop
      const destination = Math.max(0, Math.min(top, maximum))
      if (animate && next === element && Math.abs(destination - previous) < 0.5) return
      cancel()
      element = next
      viewport.scrollTo({ top, behavior: "auto" })
      position = { viewport, top: viewport.scrollTop }
      const delta = viewport.scrollTop - previous + carry
      if (!animate || reduced?.matches || !next?.animate || Math.abs(delta) < 0.5) return
      const style = getComputedStyle(next)
      const distant = Math.abs(delta) >= viewport.clientHeight
      const duration = style.getPropertyValue(distant ? "--motion-duration-base" : "--motion-duration-slow").trim()
      animation = next.animate(
        distant
          ? [{ opacity: 0.65 }, { opacity: 1 }]
          : [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        {
          duration: duration ? parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000) : distant ? 180 : 240,
          easing: style.getPropertyValue("--motion-ease-standard").trim() || "cubic-bezier(0.2, 0, 0, 1)",
          fill: "both",
        },
      )
      animation.onfinish = cancel
    },
    interrupt(viewport?: HTMLElement) {
      const carry = offset()
      cancel()
      if (viewport && carry) viewport.scrollTop -= carry
      position = undefined
    },
    settle() {
      cancel()
      position = undefined
    },
    dispose() {
      cancel()
      reduced?.removeEventListener?.("change", preference)
    },
  }
}
