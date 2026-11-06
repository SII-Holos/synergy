import { createSignal } from "solid-js"

export type SecondTickSource = {
  /** Registers a consumer. The shared 1 Hz timer runs only while at least one
   * consumer is subscribed and the document is visible. Returns unsubscribe. */
  subscribe: () => () => void
  /** Current tick counter; calling this inside a memo/effect subscribes to it. */
  read: () => number
}

type SecondTickOptions = {
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  isHidden?: () => boolean
  listenVisibility?: (handler: () => void) => () => void
}

export function createSecondTickSource(options: SecondTickOptions = {}): SecondTickSource {
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const cancel = options.cancel ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  const isHidden = options.isHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden")
  const listenVisibility =
    options.listenVisibility ??
    ((handler: () => void) => {
      if (typeof document === "undefined") return () => {}
      document.addEventListener("visibilitychange", handler)
      return () => document.removeEventListener("visibilitychange", handler)
    })

  const [tick, setTick] = createSignal(0)
  let subscribers = 0
  let timer: unknown
  let unsubscribeVisibility: (() => void) | undefined

  const stop = () => {
    if (timer === undefined) return
    cancel(timer)
    timer = undefined
  }

  const start = () => {
    if (timer !== undefined || isHidden()) return
    timer = schedule(() => setTick((count) => count + 1), 1000)
  }

  const handleVisibility = () => {
    if (isHidden()) {
      stop()
    } else if (subscribers > 0) {
      start()
    }
  }

  return {
    subscribe() {
      subscribers++
      if (subscribers === 1) {
        unsubscribeVisibility = listenVisibility(handleVisibility)
        start()
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        subscribers--
        if (subscribers === 0) {
          stop()
          unsubscribeVisibility?.()
          unsubscribeVisibility = undefined
        }
      }
    },
    read: () => tick(),
  }
}

// Module-level singleton so every avatar/greeting shares one 1 Hz timer.
// Created outside any component owner so its signal is never disposed with a
// subscribing component; the timer only runs while subscribers exist.
const shared: SecondTickSource = createSecondTickSource()

export function sharedSecondTick(): SecondTickSource {
  return shared
}
