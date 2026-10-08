import { AP } from "@/app-i18n"
import { useLingui } from "@lingui/solid"
import type { JSX } from "solid-js"
import { Show, onCleanup } from "solid-js"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import type { PluginConversationViewport } from "@ericsanchezok/synergy-plugin"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import "./conversation-viewport.css"

export function ConversationViewport(props: {
  ready?: boolean
  animateAdmission?: boolean
  scrolledUp: boolean
  onScrolledUpChange: (value: boolean) => void
  autoScroll: PluginConversationViewport
  setScrollRef: (el: HTMLDivElement | undefined, releaseOf?: HTMLDivElement) => void
  overlay?: JSX.Element
  stickyHeader?: JSX.Element
  contentClass?: string
  contentClassList?: Record<string, boolean>
  scrollButtonOffsetClass?: string
  onScrollToBottom?: () => void
  onScrollContainer?: (el: HTMLDivElement) => void
  children: JSX.Element
}) {
  const { _ } = useLingui()
  // Keyed session-tree swaps mount the successor viewport before this
  // owner's cleanup runs. Releasing with the element this viewport bound
  // lets holders ignore the stale cleanup instead of dropping the
  // successor's binding.
  let boundScrollEl: HTMLDivElement | undefined
  let boundContentEl: HTMLElement | undefined
  onCleanup(() => {
    props.setScrollRef(undefined, boundScrollEl)
    props.autoScroll.contentRef(undefined, boundContentEl)
  })
  return (
    <div class="relative w-full h-full min-w-0">
      <Show when={props.overlay}>{props.overlay}</Show>
      <Show when={props.ready === false}>
        <div class="absolute inset-0 flex items-center justify-center" role="status" aria-label={_(AP.sessionLoading)}>
          <Spinner class="size-6 text-text-weak" />
        </div>
      </Show>
      <Show when={props.ready !== false && props.scrolledUp}>
        <div
          class={`absolute right-4 md:right-6 z-20 pointer-events-auto ${props.scrollButtonOffsetClass ?? "bottom-16 md:bottom-[calc(var(--prompt-height,8rem)+16px)]"}`}
        >
          <IconButton
            icon={getSemanticIcon("navigation.latest")}
            variant="primary"
            size="large"
            class="rounded-full! size-10 transition-colors"
            aria-label={_({ id: "session.conversation.latest", message: "Back to latest" })}
            onClick={() => {
              if (props.onScrollToBottom) props.onScrollToBottom()
              else {
                props.autoScroll.forceScrollToBottom()
                props.onScrolledUpChange(false)
              }
            }}
          />
        </div>
      </Show>
      <div
        data-conversation-viewport
        data-scroll-viewport="vertical"
        data-ready={props.ready !== false}
        aria-hidden={props.ready === false}
        inert={props.ready === false}
        style={{ opacity: props.ready === false ? 0 : undefined }}
        ref={(el) => {
          boundScrollEl = el
          props.setScrollRef(el)
        }}
        onScroll={(event) => {
          props.autoScroll.handleScroll()
          const el = event.currentTarget
          props.onScrolledUpChange(el.scrollHeight - el.clientHeight - el.scrollTop > 100)
          props.onScrollContainer?.(el)
        }}
        onClick={props.autoScroll.handleInteraction}
        class="relative min-w-0 w-full h-full overflow-y-auto [overflow-x:clip] no-scrollbar md:pt-[58px] md:[scroll-padding-top:58px]"
        classList={{ "conversation-viewport-admission": props.animateAdmission !== false }}
      >
        <Show when={props.stickyHeader}>{props.stickyHeader}</Show>
        <div
          ref={(el) => {
            boundContentEl = el
            props.autoScroll.contentRef(el)
          }}
          style={{ overflow: "clip" }}
          class={["min-w-0 w-full max-w-full", props.contentClass].filter(Boolean).join(" ")}
          classList={props.contentClassList}
        >
          <div data-conversation-motion>{props.children}</div>
        </div>
      </div>
    </div>
  )
}
