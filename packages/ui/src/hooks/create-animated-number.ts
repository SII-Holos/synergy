import { createEffect, createSignal, onCleanup } from "solid-js"

/**
 * Creates a smoothly animated number that chases a target value.
 * Uses exponential smoothing (lerp) with requestAnimationFrame
 * for smooth transitions during rapid value changes.
 *
 * The animation speed adapts: faster for large gaps, smoother
 * for small adjustments. A minimum threshold prevents jitter.
 */
export function createAnimatedNumber(target: () => number): () => number {
  const [displayed, setDisplayed] = createSignal(0)
  let rafId: number | undefined
  let running = false
  let value = 0
  let lastTick = 0

  // Skip animation entirely for very small deltas to avoid jitter
  const MIN_DELTA = 1.5

  function tick(now: number) {
    rafId = undefined

    const dt = Math.min(now - lastTick, 80) // cap to 80ms
    lastTick = now
    const tgt = target()

    if (Math.abs(value - tgt) < MIN_DELTA) {
      value = tgt
      setDisplayed(Math.round(value))
      running = false
      return
    }

    // Exponential smoothing normalized to 16ms (60fps)
    const frames = dt / 16

    // Larger gaps → more urgency → faster catch-up
    const gap = Math.abs(tgt - value)
    const urgency = Math.min(gap / 800, 1) // scales from 0 to 1
    const baseSpeed = 0.3 + urgency * 0.4 // 0.3 → 0.7 lerp per frame
    const factor = Math.min(1 - Math.pow(1 - baseSpeed, frames), 1)

    value += (tgt - value) * factor
    setDisplayed(Math.round(value))

    rafId = requestAnimationFrame(tick)
  }

  function start() {
    if (running) return
    running = true
    lastTick = performance.now()
    rafId = requestAnimationFrame(tick)
  }

  createEffect(() => {
    const tgt = target()
    const delta = Math.abs(value - tgt)

    if (delta < MIN_DELTA && !running) return

    // If target went backwards (e.g., tool reset), snap immediately
    if (tgt < value) {
      value = tgt
      setDisplayed(Math.round(value))
      if (running) {
        if (rafId !== undefined) cancelAnimationFrame(rafId)
        rafId = undefined
        running = false
      }
      return
    }

    // Snap large initial jumps (first value)
    if (value === 0 && tgt > 100) {
      value = tgt
      setDisplayed(Math.round(value))
      return
    }

    if (!running) start()
  })

  onCleanup(() => {
    if (rafId !== undefined) cancelAnimationFrame(rafId)
    running = false
  })

  return () => Math.round(displayed())
}
