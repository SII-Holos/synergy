import { createEffect, createMemo, createSignal, For, Show, on, onCleanup } from "solid-js"
import type { UserMessage } from "@ericsanchezok/synergy-sdk/client"
import "./session-timeline.css"

interface SessionTimelineProps {
  messages: () => UserMessage[]
  currentMessage?: () => UserMessage | undefined
  onMessageSelect: (message: UserMessage) => void
  bottomOffset?: () => number
}

const ITEM_HEIGHT = 28

export function SessionTimeline(props: SessionTimelineProps) {
  const [trackEl, setTrackEl] = createSignal<HTMLDivElement>()
  const [containerEl, setContainerEl] = createSignal<HTMLDivElement>()

  const messages = createMemo(() => props.messages())
  const total = createMemo(() => messages()?.length ?? 0)

  const activeIndex = createMemo(() => {
    const activeId = props.currentMessage?.()?.id
    if (!activeId) return total() - 1
    const msgs = messages()
    if (!msgs) return total() - 1
    const idx = msgs.findIndex((m) => m.id === activeId)
    return idx === -1 ? total() - 1 : idx
  })

  const [containerHeight, setContainerHeight] = createSignal(0)

  createEffect(() => {
    const el = containerEl()
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height)
      }
    })
    ro.observe(el)
    onCleanup(() => ro.disconnect())
  })

  const totalTrackHeight = createMemo(() => total() * ITEM_HEIGHT)

  const [manualOffset, setManualOffset] = createSignal(0)
  createEffect(on(activeIndex, () => setManualOffset(0)))

  const scrollOffset = createMemo(() => {
    const ch = containerHeight()
    const n = total()
    if (ch <= 0 || n <= 1) return 0

    const trackH = totalTrackHeight()
    const maxScroll = Math.max(0, trackH - ch)

    const progress = activeIndex() / (n - 1)
    const base = progress * maxScroll

    const target = base + manualOffset()
    return Math.max(0, Math.min(target, maxScroll))
  })

  const centerPadding = createMemo(() => {
    const ch = containerHeight()
    const trackH = totalTrackHeight()
    if (trackH >= ch || ch <= 0) return 0
    return Math.floor((ch - trackH) / 2)
  })

  createEffect(() => {
    const el = trackEl()
    if (!el) return
    el.style.transform = `translateY(${centerPadding() - scrollOffset()}px)`
  })

  const handleWheel = (e: WheelEvent) => {
    if (total() <= 1) return
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault()
      setManualOffset((prev) => {
        const maxScroll = Math.max(0, totalTrackHeight() - containerHeight())
        const progress = activeIndex() / (total() - 1)
        const base = progress * maxScroll
        const newOffset = prev + e.deltaY
        const newTotal = base + newOffset
        if (newTotal < 0) return -base
        if (newTotal > maxScroll) return maxScroll - base
        return newOffset
      })
    }
  }

  const bottomOffset = createMemo(() => props.bottomOffset?.() ?? 0)

  return (
    <Show when={total() > 1}>
      <div
        data-component="session-timeline"
        onWheel={handleWheel}
        style={{
          top: bottomOffset() > 0 ? `calc(50% - ${bottomOffset() / 2}px)` : undefined,
        }}
      >
        <div
          ref={setContainerEl}
          data-slot="timeline-viewport"
          style={bottomOffset() > 0 ? { height: `calc(66vh - ${bottomOffset()}px)` } : undefined}
        >
          <div ref={setTrackEl} data-slot="timeline-track">
            <div
              data-slot="timeline-rail"
              style={{ height: `${totalTrackHeight() - ITEM_HEIGHT + 6}px`, top: `${ITEM_HEIGHT / 2}px` }}
            />
            <For each={messages()}>
              {(message, index) => {
                const isActive = createMemo(() => index() === activeIndex())
                return (
                  <button
                    data-slot="timeline-waypoint"
                    data-active={isActive()}
                    title=""
                    style={{ "animation-delay": `${index() * 30}ms` }}
                    onClick={(event) => {
                      event.stopPropagation()
                      props.onMessageSelect(message)
                    }}
                  >
                    <div data-slot="waypoint-dot" />
                    <span data-slot="waypoint-label">{message.summary?.title ?? `Turn ${index() + 1}`}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
