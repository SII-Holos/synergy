import type { JSX } from "solid-js"
import { Show } from "solid-js"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import type { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"

export function ConversationViewport(props: {
  scrolledUp: boolean
  onScrolledUpChange: (value: boolean) => void
  autoScroll: ReturnType<typeof createAutoScroll>
  setScrollRef: (el: HTMLDivElement | undefined) => void
  overlay?: JSX.Element
  stickyHeader?: JSX.Element
  contentClass?: string
  contentClassList?: Record<string, boolean>
  scrollButtonOffsetClass?: string
  onScrollToBottom?: () => void
  onScrollContainer?: (el: HTMLDivElement) => void
  children: JSX.Element
}) {
  return (
    <div class="relative w-full h-full min-w-0">
      <Show when={props.overlay}>{props.overlay}</Show>
      <Show when={props.scrolledUp}>
        <div
          class={`absolute right-4 md:right-6 z-20 pointer-events-auto ${props.scrollButtonOffsetClass ?? "bottom-[calc(var(--prompt-height,8rem)+16px)]"}`}
          style={{ animation: "scroll-btn-enter 250ms cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
        >
          <IconButton
            icon="chevron-down"
            variant="primary"
            size="large"
            class="rounded-full! size-10 shadow-lg hover:scale-110 active:scale-95 transition-transform"
            onClick={() => {
              props.autoScroll.forceScrollToBottom()
              props.onScrolledUpChange(false)
              props.onScrollToBottom?.()
            }}
          />
        </div>
      </Show>
      <div
        ref={props.setScrollRef}
        onScroll={(event) => {
          props.autoScroll.handleScroll()
          const el = event.currentTarget
          props.onScrolledUpChange(el.scrollHeight - el.clientHeight - el.scrollTop > 100)
          props.onScrollContainer?.(el)
        }}
        onClick={props.autoScroll.handleInteraction}
        class="relative min-w-0 w-full h-full overflow-y-auto no-scrollbar"
      >
        <Show when={props.stickyHeader}>{props.stickyHeader}</Show>
        <div ref={props.autoScroll.contentRef} class={props.contentClass} classList={props.contentClassList}>
          {props.children}
        </div>
      </div>
    </div>
  )
}
