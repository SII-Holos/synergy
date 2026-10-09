import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createScrollMotion } from "../utils/scroll-motion"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export interface AutoScrollReadingAnchor {
  owner: HTMLElement
  restore(): void
}

export interface AutoScrollOptions {
  motionTarget?: () => HTMLElement | undefined
  working: () => boolean
  onUserInteracted?: () => void
  /** Reports the distance from the bottom for content growth that fires no scroll event. */
  onMeasure?: (distanceFromBottom: number) => void
  /** How long a forced pin keeps re-pinning through late content growth (images, code blocks) before follow releases. Default 1000. */
  settleMs?: number
  captureReadingAnchor?: (input: { reading: boolean; target?: Element }) => AutoScrollReadingAnchor | undefined
}

export function createAutoScroll(options: AutoScrollOptions) {
  let scroll: HTMLElement | undefined
  let settling = false
  let forcedSettling = false
  let followingLatest = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let scrollFrame: number | undefined
  let measureFrame: number | undefined
  let forceNextScroll = false
  let down = false
  let cleanup: (() => void) | undefined
  let readingAnchor: AutoScrollReadingAnchor | undefined
  let anchoredScrollTop: number | undefined
  let movementOffset: number | undefined
  let resumeRequested = false
  let previousOffset = 0
  let interactionVersion = 0
  let smoothForce = false
  const motion = createScrollMotion(() => options.motionTarget?.())

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })
  const [readingAnchorOwner, setReadingAnchorOwner] = createSignal<HTMLElement>()

  const active = () => options.working() || settling || followingLatest
  const clearReadingAnchor = () => {
    readingAnchor = undefined
    setReadingAnchorOwner(undefined)
    anchoredScrollTop = undefined
    movementOffset = undefined
  }
  const preserveReadingAnchor = (target?: Element) => {
    if (!store.userScrolled) {
      clearReadingAnchor()
      return
    }
    readingAnchor = options.captureReadingAnchor?.({ reading: store.userScrolled, target })
    setReadingAnchorOwner(readingAnchor?.owner)
    anchoredScrollTop = scroll?.scrollTop
  }

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
    if (Math.abs(distance) < 2 && !options.motionTarget) return

    const animate =
      !!options.motionTarget && (!force || smoothForce) && !store.contentRef?.querySelector("[data-motion-resizing]")
    motion.move(scroll, bottom, animate)
    smoothForce = false
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return
    if (!scroll) return
    if (!force && store.userScrolled) return
    if (force) {
      resumeRequested = false
      clearReadingAnchor()
    }

    // A forced pin lands on whatever layout exists right now; open the settle
    // window immediately so late content growth keeps re-pinning underneath.
    if (force) beginSettle(settleWindow(), true)
    forceNextScroll ||= force
    if (scrollFrame !== undefined) return
    scrollFrame = requestAnimationFrame(flushScrollToBottom)
  }

  const stop = (allowResume = false) => {
    interactionVersion++
    motion.interrupt(scroll)
    resumeRequested = allowResume
    followingLatest = false
    forceNextScroll = false
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    scrollFrame = undefined
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const beginMovement = () => {
    anchoredScrollTop = undefined
    movementOffset = scroll?.scrollTop
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY) beginMovement()
    if (e.deltaY < 0) stop()
    else if (e.deltaY > 0) resumeRequested = true
  }

  const handlePointerUp = () => {
    down = false
    window.removeEventListener("pointerup", handlePointerUp)
  }

  const handlePointerDown = () => {
    beginMovement()
    if (followingLatest) stop()
    resumeRequested = true
    if (down) return
    down = true
    window.addEventListener("pointerup", handlePointerUp)
  }

  const handleTouchEnd = () => {
    down = false
    window.removeEventListener("touchend", handleTouchEnd)
  }

  const handleTouchStart = () => {
    beginMovement()
    if (followingLatest) stop()
    resumeRequested = true
    if (down) return
    down = true
    window.addEventListener("touchend", handleTouchEnd)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return
    if (event.key === " ") {
      if (event.target instanceof Element && event.target.closest("button, summary, [role=button]")) return
      beginMovement()
      if (event.shiftKey) stop()
      else resumeRequested = true
      return
    }
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
      beginMovement()
      stop()
    }
    if (["ArrowDown", "PageDown", "End"].includes(event.key)) {
      beginMovement()
      resumeRequested = true
    }
  }

  const handleScroll = () => {
    if (!scroll) return
    const compensated = anchoredScrollTop !== undefined && Math.abs(scroll.scrollTop - anchoredScrollTop) < 1
    anchoredScrollTop = undefined
    const advancing = scroll.scrollTop > previousOffset
    previousOffset = scroll.scrollTop
    if (!compensated && resumeRequested && advancing && distanceFromBottom() < 10) {
      if (store.userScrolled) setStore("userScrolled", false)
      followingLatest = true
      clearReadingAnchor()
      resumeRequested = false
      return
    }
    if (!compensated && down) stop(resumeRequested)
    if (!compensated) {
      movementOffset = undefined
      preserveReadingAnchor()
    }
  }

  const handleInteraction = (event?: Event) => {
    movementOffset = undefined
    stop()
    preserveReadingAnchor(event && event.target instanceof Element ? event.target : undefined)
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      // While pinned-follow, resizes only re-pin (and extend an active settle
      // window). Otherwise content grows without scroll events, so report the
      // distance so "scrolled up" state stays honest in idle sessions.
      if (active() && !store.userScrolled) {
        if (forcedSettling) beginSettle(settleWindow(), true)
        // Resize delivery follows frame callbacks; another frame would paint the new height before its latest pin.
        if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
        flushScrollToBottom()
        return
      }
      if (movementOffset !== undefined && scroll && Math.abs(scroll.scrollTop - movementOffset) > 0.5) {
        scheduleMeasure()
        return
      }
      readingAnchor?.restore()
      if (readingAnchor && !readingAnchor.owner.isConnected) preserveReadingAnchor()
      if (scroll && readingAnchor) {
        anchoredScrollTop = scroll.scrollTop
        if (movementOffset !== undefined) movementOffset = scroll.scrollTop
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
    motion.dispose()
    followingLatest = false
    clearReadingAnchor()
    if (settleTimer) clearTimeout(settleTimer)
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
    if (cleanup) cleanup()
  })

  return {
    scrollRef: (el: HTMLElement | undefined, releaseOf?: HTMLElement) => {
      // A keyed subtree swap mounts the successor viewport before the
      // swapped-out owner's cleanup runs; an attributed release only
      // clears a binding it still owns.
      if (!el && releaseOf !== undefined && scroll !== releaseOf) return
      if (scroll === el) return
      if (cleanup) {
        cleanup()
        cleanup = undefined
      }

      motion.settle()
      clearReadingAnchor()
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined
      settling = false
      forcedSettling = false
      followingLatest = false
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
      if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
      scrollFrame = undefined
      measureFrame = undefined
      forceNextScroll = false
      scroll = el
      down = false
      resumeRequested = false
      previousOffset = el?.scrollTop ?? 0

      if (!el) return
      if (store.userScrolled) setStore("userScrolled", false)

      el.style.overflowAnchor = "none"
      el.addEventListener("wheel", handleWheel, { passive: true })
      el.addEventListener("pointerdown", handlePointerDown)
      el.addEventListener("touchstart", handleTouchStart, { passive: true })
      el.addEventListener("keydown", handleKeyDown)

      cleanup = () => {
        el.removeEventListener("wheel", handleWheel)
        el.removeEventListener("pointerdown", handlePointerDown)
        el.removeEventListener("touchstart", handleTouchStart)
        el.removeEventListener("keydown", handleKeyDown)
        window.removeEventListener("pointerup", handlePointerUp)
        window.removeEventListener("touchend", handleTouchEnd)
      }
    },
    contentRef: (el: HTMLElement | undefined, releaseOf?: HTMLElement) => {
      if (!el && releaseOf !== undefined && store.contentRef !== releaseOf) return
      if (store.contentRef === el) return
      clearReadingAnchor()
      setStore("contentRef", el)
    },
    handleScroll,
    handleInteraction,
    preserveReadingAnchor,
    readingAnchorOwner,
    interactionVersion: () => interactionVersion,
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: (input?: { untilInteraction?: boolean; smooth?: boolean }) => {
      smoothForce = input?.smooth === true
      if (scroll && input?.untilInteraction) followingLatest = true
      scrollToBottom(true)
    },
    userScrolled: () => store.userScrolled,
  }
}
