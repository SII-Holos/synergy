import type { PluginConversationActivityView } from "@ericsanchezok/synergy-plugin"
import type { ReasoningPart } from "@ericsanchezok/synergy-sdk/client"
import { useLingui } from "@lingui/solid"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createAutoScroll } from "../hooks/create-auto-scroll"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { compactReasoningFirstLine } from "./compact-reasoning-text"
import { useData } from "../context/data"
import { createDisclosureMotionRef } from "../utils/disclosure-motion"
import type { ActivityReasoningSummaryItem } from "./session-turn-activity"
import "./activity-batch.css"

export function ActivityReasoning(props: {
  item: ActivityReasoningSummaryItem
  working: boolean
  initial?: boolean
  preview: boolean
  view?: PluginConversationActivityView
  onInspect?: () => void
}) {
  const data = useData()
  const entries = () =>
    data.view
      .partsFor(props.item.message.id)
      .filter((part): part is ReasoningPart => part.type === "reasoning" && part.id === props.item.partID)
  return (
    <ProcessReasoning
      entries={entries()}
      identity={props.item.key}
      running={props.working && props.item.message.time.completed == null && entries().at(-1)?.time?.end == null}
      defaultOpen={props.initial && props.working}
      preview={props.preview}
      view={props.view}
      onInspect={props.onInspect}
    />
  )
}

export function ProcessReasoning(props: {
  entries: readonly ReasoningPart[]
  identity: string
  running: boolean
  preview: boolean
  defaultOpen?: boolean
  view?: PluginConversationActivityView
  onInspect?: () => void
}) {
  const { _ } = useLingui()
  const [explicit, setExplicit] = createSignal<boolean>()
  const open = createMemo(() => props.view?.getExpanded(props.identity) ?? explicit() ?? props.defaultOpen === true)
  const text = () => props.entries.map((part) => part.text).join("\n\n")
  const segments = createMemo(() => {
    const result: { messageID: string; entries: ReasoningPart[] }[] = []
    for (const part of props.entries) {
      const previous = result.at(-1)
      if (previous?.messageID === part.messageID) previous.entries.push(part)
      else result.push({ messageID: part.messageID, entries: [part] })
    }
    return result
  })
  const scroll = createAutoScroll({ working: () => open() })
  createEffect(
    on(open, (value) => {
      if (value) scroll.forceScrollToBottom()
    }),
  )
  createEffect(() => {
    if (!open()) return
    text()
    scroll.scrollToBottom()
  })
  const panelRef = createDisclosureMotionRef({ visible: open, animate: () => true })
  return (
    <div data-component="process-reasoning">
      <button
        type="button"
        data-slot="process-reasoning-trigger"
        aria-expanded={open()}
        aria-controls={`${props.identity}:detail`}
        aria-label={
          open()
            ? _({ id: "session.process.hideReasoning", message: "Hide reasoning" })
            : _({ id: "session.process.viewReasoning", message: "View reasoning" })
        }
        onClick={() => {
          const next = !open()
          if (props.view) props.view.setExpanded(props.identity, next)
          else setExplicit(next)
          if (next) props.onInspect?.()
        }}
      >
        <Icon name={getSemanticIcon("performance.trace")} size="small" />
        <span>
          {props.running
            ? _({ id: "session.process.thinking", message: "Thinking" })
            : _({ id: "session.reasoning.title", message: "Reasoning" })}
        </span>
        <Show when={props.running}>
          <span data-slot="activity-live-indicator" aria-hidden="true" />
        </Show>
        <Icon name={getSemanticIcon("navigation.expand")} size="small" />
      </button>
      <Show when={props.preview && !open()}>
        <span data-slot="process-reasoning-preview">
          {compactReasoningFirstLine(
            segments()
              .at(-1)
              ?.entries.map((part) => part.text)
              .join("\n\n") ?? "",
          )}
        </span>
      </Show>
      <div data-slot="process-reasoning-panel" ref={panelRef}>
        <Show when={segments().length > 1 || scroll.userScrolled()}>
          <div data-slot="reasoning-toolbar">
            <Show when={segments().length > 1}>
              <span>
                {_({
                  id: "session.reasoning.segments",
                  message: "{count, plural, one {# reasoning segment} other {# reasoning segments}}",
                  values: { count: segments().length },
                })}
              </span>
            </Show>
            <button type="button" data-slot="reasoning-latest" onClick={() => scroll.forceScrollToBottom()}>
              {_({ id: "session.reasoning.latest", message: "Latest reasoning" })}
            </button>
          </div>
        </Show>
        <div
          id={`${props.identity}:detail`}
          ref={scroll.scrollRef}
          onScroll={scroll.handleScroll}
          onKeyDown={(event) => {
            if (["ArrowUp", "PageUp", "Home"].includes(event.key)) scroll.handleInteraction()
          }}
          data-slot="process-reasoning-detail"
          tabindex="0"
          role="region"
          aria-label={_({ id: "session.process.viewReasoning", message: "View reasoning" })}
        >
          <div ref={scroll.contentRef}>
            <For each={segments().map((segment) => segment.messageID)}>
              {(messageID, index) => (
                <section data-slot="reasoning-segment" data-message-id={messageID}>
                  <Show when={segments().length > 1}>
                    <div data-slot="reasoning-segment-heading">
                      {_({
                        id: "session.reasoning.segment",
                        message: "Reasoning {number}",
                        values: { number: index() + 1 },
                      })}
                    </div>
                  </Show>
                  <For
                    each={segments()
                      .find((segment) => segment.messageID === messageID)
                      ?.entries.map((part) => part.id)}
                  >
                    {(id) => <div data-reasoning-part={id}>{props.entries.find((part) => part.id === id)?.text}</div>}
                  </For>
                </section>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}
