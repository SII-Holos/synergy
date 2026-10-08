import { onCleanup } from "solid-js"

// Provenance: https://web.dev/articles/animations-guide#avoid_properties_that_trigger_layout_or_paint
// Local adaptation: Commit virtual geometry once, then move connected retained rows without animating their measured sizes.
export function createConversationLayoutMotion(container: () => HTMLElement | undefined) {
  const animations = new Map<string, { element: HTMLElement; animation: Animation }>()
  const reduced = matchMedia("(prefers-reduced-motion: reduce)")
  let generation = 0
  let disposed = false
  const release = (key: string) => {
    const current = animations.get(key)
    if (!current) return
    const { element, animation } = current
    animation.onfinish = null
    animation.cancel()
    element.removeAttribute("data-layout-changing")
    animations.delete(key)
  }
  const cancel = () => {
    for (const key of animations.keys()) release(key)
  }
  const preference = () => {
    if (!reduced.matches) return
    generation++
    cancel()
  }
  reduced.addEventListener("change", preference)
  onCleanup(() => {
    disposed = true
    generation++
    cancel()
    reduced.removeEventListener("change", preference)
  })
  const capture = (measure: () => void) => {
    const current = ++generation
    const positions = new Map(
      [...(container()?.querySelectorAll<HTMLElement>("[data-display-row]") ?? [])].map((row) => [
        row.dataset.displayRow!,
        row.parentElement!.getBoundingClientRect().top,
      ]),
    )
    return () =>
      queueMicrotask(() => {
        if (disposed || current !== generation) return
        cancel()
        measure()
        if (reduced.matches) return
        const movements = [...(container()?.querySelectorAll<HTMLElement>("[data-display-row]") ?? [])].flatMap(
          (row) => {
            const top = positions.get(row.dataset.displayRow!)
            const element = row.parentElement!
            if (top === undefined || !element.isConnected) return []
            const distance = top - element.getBoundingClientRect().top
            return Math.abs(distance) > 1 ? [{ key: row.dataset.displayRow!, element, distance }] : []
          },
        )
        const style = container() && getComputedStyle(container()!)
        const duration = style?.getPropertyValue("--motion-duration-base").trim()
        const milliseconds = duration ? parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000) : 180
        const easing = style?.getPropertyValue("--motion-ease-standard").trim() || "cubic-bezier(0.2, 0, 0, 1)"
        for (const { key, element, distance } of movements) {
          const animation = element.animate(
            [{ transform: `translateY(${distance}px)` }, { transform: "translateY(0)" }],
            { duration: milliseconds, easing, fill: "both" },
          )
          element.setAttribute("data-layout-changing", "")
          animations.set(key, { element, animation })
          animation.onfinish = () => {
            if (animations.get(key)?.animation === animation) release(key)
          }
        }
      })
  }
  const interrupt = () => {
    generation++
    cancel()
  }
  return { capture, release, interrupt }
}
