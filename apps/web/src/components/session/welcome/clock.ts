import { createEffect, onCleanup, type Accessor } from "solid-js"

export function useSceneClock(active: Accessor<boolean>, update: (seconds: number) => void) {
  createEffect(() => {
    if (!active()) return
    let disposed = false
    let previous: number | undefined
    let frame = requestAnimationFrame(tick)
    function tick(now: number) {
      if (disposed) return
      if (previous !== undefined) update(Math.min((now - previous) / 1000, 0.05))
      previous = now
      if (!disposed) frame = requestAnimationFrame(tick)
    }
    onCleanup(() => {
      disposed = true
      cancelAnimationFrame(frame)
    })
  })
}
