import { createEffect, onCleanup, type Accessor } from "solid-js"

export function useSceneClock(active: Accessor<boolean>, update: (seconds: number) => void) {
  createEffect(() => {
    if (!active()) return
    let previous: number | undefined
    let frame = requestAnimationFrame(tick)
    function tick(now: number) {
      if (previous !== undefined) update(Math.min((now - previous) / 1000, 0.05))
      previous = now
      frame = requestAnimationFrame(tick)
    }
    onCleanup(() => cancelAnimationFrame(frame))
  })
}
