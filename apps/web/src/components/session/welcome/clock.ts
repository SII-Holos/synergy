import { batch, createEffect, onCleanup, type Accessor } from "solid-js"

export function useSceneClock(active: Accessor<boolean>, update: (seconds: number) => void) {
  createEffect(() => {
    if (!active()) return
    let disposed = false
    let previous: number | undefined
    let frame = requestAnimationFrame(tick)
    function tick(now: number) {
      if (disposed) return
      if (previous !== undefined) {
        const seconds = Math.min((now - previous) / 1000, 0.1)
        batch(() => update(seconds))
      }
      previous = now
      if (!disposed) frame = requestAnimationFrame(tick)
    }
    onCleanup(() => {
      disposed = true
      cancelAnimationFrame(frame)
    })
  })
}
