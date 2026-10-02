import type { PluginConversationActivityView } from "@ericsanchezok/synergy-plugin"
import { useLingui } from "@lingui/solid"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { ActivityTrace } from "./activity-trace"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import type { ActivityBatchItem, ActivityDisplayMode, ActivityFamily } from "./session-turn-activity"
import { activityBatchCurrentSteps, activityBatchWindow } from "./session-turn-process"
import type { MessageDescriptor } from "@lingui/core"
import { compactReasoningFirstLine } from "./compact-reasoning-text"
import { createAutoScroll } from "../hooks/create-auto-scroll"
import type { ReasoningPart } from "@ericsanchezok/synergy-sdk/client"
import { MAX_ACTIVITY_GROUP_STEPS } from "@ericsanchezok/synergy-util/activity"
import "./activity-batch.css"

const facts: Record<ActivityFamily, MessageDescriptor> = {
  "inspect-local": {
    id: "activity.batch.inspect",
    message: "{count, plural, one {Inspected # item} other {Inspected # items}}",
  },
  "research-web": {
    id: "activity.batch.research",
    message: "{count, plural, one {Researched # source} other {Researched # sources}}",
  },
  "modify-files": {
    id: "activity.batch.modify",
    message: "{count, plural, one {Made # file change} other {Made # file changes}}",
  },
  execute: { id: "activity.batch.execute", message: "{count, plural, one {Ran # command} other {Ran # commands}}" },
  browser: {
    id: "activity.batch.browser",
    message: "{count, plural, one {Performed # browser action} other {Performed # browser actions}}",
  },
  delegate: {
    id: "activity.batch.delegate",
    message: "{count, plural, one {Delegated # task} other {Delegated # tasks}}",
  },
  produce: { id: "activity.batch.produce", message: "{count, plural, one {Produced # item} other {Produced # items}}" },
  "external-action": {
    id: "activity.batch.external",
    message: "{count, plural, one {Performed # external action} other {Performed # external actions}}",
  },
  coordination: {
    id: "activity.batch.coordinate",
    message: "{count, plural, one {Coordinated # action} other {Coordinated # actions}}",
  },
  generic: {
    id: "activity.batch.generic",
    message: "{count, plural, one {Performed # action} other {Performed # actions}}",
  },
}
export function ActivityBatch(props: {
  batch: ActivityBatchItem
  serverUrl: string
  mode: ActivityDisplayMode
  active: boolean
  following: boolean
  view?: PluginConversationActivityView
  onInspect?: () => void
}) {
  const { _ } = useLingui()
  const countedFact = (descriptor: MessageDescriptor, count: number) => _({ ...descriptor, values: { count } })
  const [explicit, setExplicit] = createSignal<boolean>()
  const [retained, setRetained] = createSignal<string[]>([])
  const [focused, setFocused] = createSignal<string>()
  const [pageEnd, setPageEnd] = createSignal<number>()
  const current = createMemo(() => activityBatchCurrentSteps(props.batch, props.active))
  createEffect(
    on(
      () => props.following,
      (following, previous) => {
        if (following) setRetained([])
        else if (previous !== false) setRetained(current())
      },
    ),
  )
  const open = () => props.view?.getExpanded(props.batch.key) ?? explicit() ?? props.mode === "full"
  const pinned = createMemo(() => new Set([...current(), ...retained(), ...(focused() ? [focused()!] : [])]))
  const window = createMemo(() => activityBatchWindow(props.batch, pageEnd(), [...pinned()]))
  const visible = createMemo(() => new Set(open() ? window().steps.map((step) => step.part.id) : pinned()))
  const inspectionLabel = () => {
    const labels: string[] = []
    if (props.batch.fileReads !== undefined)
      labels.push(
        _({
          id: "activity.batch.readFiles",
          message: "{count, plural, one {Read # file} other {Read # files}}",
          values: { count: props.batch.fileReads },
        }),
      )
    else if (props.batch.fileReadOperations)
      labels.push(
        _({
          id: "activity.batch.readOperations",
          message: "{count, plural, one {Read files # time} other {Read files # times}}",
          values: { count: props.batch.fileReadOperations },
        }),
      )
    if (props.batch.searchOperations)
      labels.push(
        _({
          id: "activity.batch.searched",
          message: "{count, plural, one {Searched # time} other {Searched # times}}",
          values: { count: props.batch.searchOperations },
        }),
      )
    if (props.batch.inspectionOperations)
      labels.push(countedFact(facts["inspect-local"], props.batch.inspectionOperations))
    return labels.join(" · ")
  }
  const label = createMemo(() =>
    props.batch.facts.some((fact) => fact.count > 0)
      ? props.batch.facts
          .map((fact) =>
            fact.family === "inspect-local"
              ? inspectionLabel() || countedFact(facts[fact.family], fact.count)
              : countedFact(facts[fact.family], fact.count),
          )
          .join(" · ")
      : _({
          id: "activity.batch.attempted",
          message: "{count, plural, one {Attempted # action} other {Attempted # actions}}",
          values: { count: props.batch.steps.length },
        }),
  )
  const group = createMemo(() => ({
    kind: "activity-group" as const,
    key: props.batch.key,
    message: props.batch.message,
    family: props.batch.steps[0].family,
    scopeKey: "",
    state: props.batch.state,
    steps: window().steps,
    receipt: false,
  }))
  return (
    <div data-component="activity-batch" data-state={props.batch.state}>
      <Show when={props.batch.steps.some((step) => step.state === "done" || step.state === "error") || !props.active}>
        <button
          data-slot="activity-batch-trigger"
          type="button"
          aria-expanded={open()}
          aria-controls={`${props.batch.key}:steps`}
          onClick={() => {
            const value = !open()
            if (props.view) props.view.setExpanded(props.batch.key, value)
            else setExplicit(value)
            if (value) props.onInspect?.()
          }}
        >
          <span>{label()}</span>
          <Icon name={getSemanticIcon("navigation.expand")} size="small" />
        </button>
      </Show>
      <Show when={open() && window().total > MAX_ACTIVITY_GROUP_STEPS}>
        <div data-slot="activity-history-pages">
          <button
            type="button"
            data-slot="activity-history-earlier"
            disabled={window().first === 0}
            onClick={() => setPageEnd(window().first)}
          >
            {_({ id: "activity.history.earlier", message: "Earlier actions" })}
          </button>
          <span>
            {_({
              id: "activity.history.range",
              message: "{first}–{last} of {total}",
              values: { first: window().first + 1, last: window().last, total: window().total },
            })}
          </span>
          <button
            type="button"
            data-slot="activity-history-later"
            disabled={pageEnd() === undefined}
            onClick={() =>
              setPageEnd(
                window().last + MAX_ACTIVITY_GROUP_STEPS >= window().total
                  ? undefined
                  : window().last + MAX_ACTIVITY_GROUP_STEPS,
              )
            }
          >
            {_({ id: "activity.history.later", message: "Later actions" })}
          </button>
        </div>
      </Show>
      <ActivityTrace
        id={`${props.batch.key}:steps`}
        group={group()}
        serverUrl={props.serverUrl}
        visibleSteps={visible()}
        currentSteps={new Set(current())}
        quiet
        onStepFocus={setFocused}
      />
    </div>
  )
}

export function ProcessReasoning(props: {
  entries: readonly ReasoningPart[]
  identity: string
  running: boolean
  preview: boolean
  view?: PluginConversationActivityView
  onInspect?: () => void
}) {
  const { _ } = useLingui()
  const [explicit, setExplicit] = createSignal(false)
  const open = () => props.view?.getExpanded(props.identity) ?? explicit()
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
  return (
    <div data-component="process-reasoning">
      <button
        type="button"
        data-slot="process-reasoning-trigger"
        aria-expanded={open()}
        aria-controls={`${props.identity}:detail`}
        onClick={() => {
          const next = !open()
          if (props.view) props.view.setExpanded(props.identity, next)
          else setExplicit(next)
          if (next) props.onInspect?.()
        }}
      >
        <Icon name={getSemanticIcon("performance.trace")} size="small" />
        <span>
          {open()
            ? _({ id: "session.process.hideReasoning", message: "Hide reasoning" })
            : _({ id: "session.process.viewReasoning", message: "View reasoning" })}
        </span>
        <Show when={props.running}>
          <span data-slot="activity-live-indicator" aria-hidden="true" />
        </Show>
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
      <div data-slot="process-reasoning-panel" hidden={!open()}>
        <div data-slot="reasoning-toolbar">
          <span>
            {_({
              id: "session.reasoning.segments",
              message: "{count, plural, one {# reasoning segment} other {# reasoning segments}}",
              values: { count: segments().length },
            })}
          </span>
          <button type="button" data-slot="reasoning-latest" onClick={() => scroll.forceScrollToBottom()}>
            {_({ id: "session.reasoning.latest", message: "Latest reasoning" })}
          </button>
        </div>
        <div
          id={`${props.identity}:detail`}
          ref={scroll.scrollRef}
          onScroll={scroll.handleScroll}
          onKeyDown={(event) => {
            if (["ArrowUp", "PageUp", "Home"].includes(event.key)) scroll.handleInteraction()
          }}
          data-slot="process-reasoning-detail"
          hidden={!open()}
          tabindex="0"
          role="region"
          aria-label={_({ id: "session.process.viewReasoning", message: "View reasoning" })}
        >
          <div ref={scroll.contentRef}>
            <For each={segments().map((segment) => segment.messageID)}>
              {(messageID, index) => (
                <section data-slot="reasoning-segment" data-message-id={messageID}>
                  <div data-slot="reasoning-segment-heading">
                    {_({
                      id: "session.reasoning.segment",
                      message: "Reasoning {number}",
                      values: { number: index() + 1 },
                    })}
                  </div>
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
