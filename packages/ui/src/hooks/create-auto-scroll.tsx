import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  /** Reports the distance from the bottom for content growth that fires no scroll event. */
  onMeasure?: (distanceFromBottom: number) => void
  /** How long a forced pin keeps re-pinning through late content growth (images, code blocks) before follow releases. Default 1000. */
  settleMs?: number
}

export function createAutoScroll(options: AutoScrollOptions) {
  let scroll: HTMLElement | undefined
  let settling = false
  let forcedSettling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let scrollFrame: number | undefined
  let measureFrame: number | undefined
  let forceNextScroll = false
  let down = false
  let cleanup: (() => void) | undefined

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = () => {
    const el = scroll
    if (!el) return 0
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const settleWindow = () => options.settleMs ?? 1000

  const beginSettle = (ms: number, forced = false) => {
    if (forcedSettling && !forced) return
    settling = true
    forcedSettling = forced
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settling = false
      forcedSettling = false
      settleTimer = undefined
    }, ms)
  }

  const scheduleMeasure = () => {
    if (measureFrame !== undefined) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = undefined
      options.onMeasure?.(distanceFromBottom())
    })
  }

  const flushScrollToBottom = () => {
    scrollFrame = undefined
    const force = forceNextScroll
    forceNextScroll = false

    if (!force && !active()) return
    if (!scroll) return

    if (!force && store.userScrolled) return
    if (force && store.userScrolled) setStore("userScrolled", false)

    const bottom = scroll.scrollHeight
    const distance = bottom - scroll.clientHeight - scroll.scrollTop
    if (distance < 2) return

    scroll.scrollTo({ top: bottom, behavior: "auto" })
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return
    if (!scroll) return
    if (!force && store.userScrolled) return

    // A forced pin lands on whatever layout exists right now; open the settle
    // window immediately so late content growth keeps re-pinning underneath.
    if (force) beginSettle(settleWindow(), true)
    forceNextScroll ||= force
    if (scrollFrame !== undefined) return
    scrollFrame = requestAnimationFrame(flushScrollToBottom)
  }

  const stop = () => {
    if (!active()) return
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    stop()
  }

  const handlePointerUp = () => {
    down = false
    window.removeEventListener("pointerup", handlePointerUp)
  }

  const handlePointerDown = () => {
    if (down) return
    down = true
    window.addEventListener("pointerup", handlePointerUp)
  }

  const handleTouchEnd = () => {
    down = false
    window.removeEventListener("touchend", handleTouchEnd)
  }

  const handleTouchStart = () => {
    if (down) return
    down = true
    window.addEventListener("touchend", handleTouchEnd)
  }

  const handleScroll = () => {
    if (!active()) return
    if (!scroll) return

    if (distanceFromBottom() < 10) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    if (down) stop()
  }

  const handleInteraction = () => {
    stop()
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      // While pinned-follow, resizes only re-pin (and extend an active settle
      // window). Otherwise content grows without scroll events, so report the
      // distance so "scrolled up" state stays honest in idle sessions.
      if (active() && !store.userScrolled) {
        if (forcedSettling) beginSettle(settleWindow(), true)
        scrollToBottom(false)
        return
      }
      scheduleMeasure()
    },
  )

  createEffect(
    on(options.working, (working) => {
      if (working) {
        if (!store.userScrolled) {
          scrollToBottom(false)
        }
        return
      }

      if (!store.userScrolled) {
        beginSettle(300)
      }
    }),
  )

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
    if (cleanup) cleanup()
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => {
      if (cleanup) {
        cleanup()
        cleanup = undefined
      }

      if (scroll !== el) {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = undefined
        settling = false
        forcedSettling = false
        if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
        if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
        scrollFrame = undefined
        measureFrame = undefined
        forceNextScroll = false
      }
      scroll = el
      down = false

      if (!el) return
      if (store.userScrolled) setStore("userScrolled", false)

      el.style.overflowAnchor = "none"
      el.addEventListener("wheel", handleWheel, { passive: true })
      el.addEventListener("pointerdown", handlePointerDown)
      el.addEventListener("touchstart", handleTouchStart, { passive: true })

      cleanup = () => {
        el.removeEventListener("wheel", handleWheel)
        el.removeEventListener("pointerdown", handlePointerDown)
        el.removeEventListener("touchstart", handleTouchStart)
        window.removeEventListener("pointerup", handlePointerUp)
        window.removeEventListener("touchend", handleTouchEnd)
      }
    },
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled: () => store.userScrolled,
  }
}
