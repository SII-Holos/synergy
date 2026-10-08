import type { PluginConversationActivityView } from "@ericsanchezok/synergy-plugin"
import { Trans, useLingui } from "@lingui/solid"
import { createComponent, createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { ActivityTrace, AnimatedActivityCount } from "./activity-trace"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import type {
  ActivityBatchItem,
  ActivityDisplayMode,
  ActivityFamily,
  ActivityReasoningSummaryItem,
} from "./session-turn-activity"
import { activityBatchCurrentSteps, activityBatchWindow } from "./session-turn-process"
import type { MessageDescriptor } from "@lingui/core"
import { ActivityReasoning } from "./process-reasoning"
import { createDisclosureMotionRef } from "../utils/disclosure-motion"
import { MAX_ACTIVITY_GROUP_STEPS } from "@ericsanchezok/synergy-util/activity"
import "./activity-batch.css"
import { ProcessViewport } from "./process-viewport"
import { useData } from "../context/data"
import { createActivityLabel } from "./session-status"

const facts: Record<ActivityFamily, MessageDescriptor> = {
  "inspect-local": {
    id: "activity.batch.inspect",
    message: "{count, plural, one {Inspected <number/> item} other {Inspected <number/> items}}",
  },
  "research-web": {
    id: "activity.batch.research",
    message: "{count, plural, one {Researched <number/> source} other {Researched <number/> sources}}",
  },
  "modify-files": {
    id: "activity.batch.modify",
    message: "{count, plural, one {Made <number/> file change} other {Made <number/> file changes}}",
  },
  execute: {
    id: "activity.batch.execute",
    message: "{count, plural, one {Ran <number/> command} other {Ran <number/> commands}}",
  },
  browser: {
    id: "activity.batch.browser",
    message: "{count, plural, one {Performed <number/> browser action} other {Performed <number/> browser actions}}",
  },
  delegate: {
    id: "activity.batch.delegate",
    message: "{count, plural, one {Delegated <number/> task} other {Delegated <number/> tasks}}",
  },
  produce: {
    id: "activity.batch.produce",
    message: "{count, plural, one {Produced <number/> item} other {Produced <number/> items}}",
  },
  "external-action": {
    id: "activity.batch.external",
    message: "{count, plural, one {Performed <number/> external action} other {Performed <number/> external actions}}",
  },
  coordination: {
    id: "activity.batch.coordinate",
    message: "{count, plural, one {Coordinated <number/> action} other {Coordinated <number/> actions}}",
  },
  generic: {
    id: "activity.batch.generic",
    message: "{count, plural, one {Performed <number/> action} other {Performed <number/> actions}}",
  },
}
export function ActivityBatchLabel(props: {
  batch: Pick<
    ActivityBatchItem,
    "facts" | "fileReads" | "fileReadOperations" | "searchOperations" | "inspectionOperations"
  >
  total: number
  identity?: string
  live?: boolean
}) {
  const [totalShown, setTotalShown] = createSignal(false)
  const entries = createMemo(() => {
    const result: { key: string; descriptor: MessageDescriptor; count: number }[] = []
    const add = (key: string, descriptor: MessageDescriptor, count: number) => result.push({ key, descriptor, count })
    for (const fact of props.batch.facts) {
      if (!fact.count) continue
      if (fact.family !== "inspect-local") {
        add(fact.family, facts[fact.family], fact.count)
        continue
      }
      const start = result.length
      if (props.batch.fileReads !== undefined)
        add(
          "files",
          {
            id: "activity.batch.readFiles",
            message: "{count, plural, one {Read <number/> file} other {Read <number/> files}}",
          },
          props.batch.fileReads,
        )
      else if (props.batch.fileReadOperations)
        add(
          "reads",
          {
            id: "activity.batch.readOperations",
            message: "{count, plural, one {Read files <number/> time} other {Read files <number/> times}}",
          },
          props.batch.fileReadOperations,
        )
      if (props.batch.searchOperations)
        add(
          "searches",
          {
            id: "activity.batch.searched",
            message: "{count, plural, one {Searched <number/> time} other {Searched <number/> times}}",
          },
          props.batch.searchOperations,
        )
      if (props.batch.inspectionOperations) add(fact.family, facts[fact.family], props.batch.inspectionOperations)
      if (start === result.length) add(fact.family, facts[fact.family], fact.count)
    }
    return result
  })
  const needsTotal = () =>
    !entries().length ||
    entries().length > 2 ||
    props.batch.facts.reduce((sum, fact) => sum + fact.count, 0) < props.total
  createEffect(
    on(
      () => props.identity,
      () => setTotalShown(false),
    ),
  )
  createEffect(() => {
    if (needsTotal()) setTotalShown(true)
  })
  const labels = createMemo(() => [
    ...entries().slice(0, 2),
    ...(needsTotal() || totalShown()
      ? [
          {
            key: "total",
            descriptor: {
              id: "activity.batch.total",
              message: "{count, plural, one {<number/> action} other {<number/> actions}}",
            },
            count: props.total,
          },
        ]
      : []),
  ])
  return (
    <For each={labels().map((entry) => entry.key)}>
      {(key, index) => {
        const entry = () => labels().find((entry) => entry.key === key)!
        const number = (
          <AnimatedActivityCount
            value={entry().count}
            identity={`${props.identity ?? "batch"}:${key}`}
            animate={props.live === true}
          />
        )
        return (
          <>
            <Show when={index() > 0}>
              <span aria-hidden="true"> · </span>
            </Show>
            <span data-activity-fact={key}>
              {createComponent(Trans, {
                get id() {
                  return entry().descriptor.id
                },
                get message() {
                  return entry().descriptor.message
                },
                get values() {
                  return { count: entry().count }
                },
                components: { number: () => number },
              })}
            </span>
          </>
        )
      }}
    </For>
  )
}

export function ActivityBatchStatus(props: { label?: string; animated?: boolean }) {
  const label = createActivityLabel(
    () => props.label,
    () => props.animated === true,
  )
  return (
    <Show when={label()}>
      <span data-slot="activity-batch-status">
        <span aria-hidden="true"> · </span>
        <span
          data-slot="activity-batch-status-text"
          data-animated={props.animated === true}
          aria-live="polite"
          aria-atomic="true"
        >
          {label()}
        </span>
      </span>
    </Show>
  )
}

export function ActivityBatch(props: {
  batch: ActivityBatchItem
  serverUrl: string
  mode: ActivityDisplayMode
  active: boolean
  statusLabel?: string
  statusAnimated?: boolean
  following: boolean
  reasoningPreview?: boolean
  view?: PluginConversationActivityView
  onInspect?: () => void
  onBeforeLayoutChange?: (event: Event) => void
}) {
  const { _ } = useLingui()
  const data = useData()
  const [explicit, setExplicit] = createSignal<boolean>()
  const [retained, setRetained] = createSignal<string[]>([])
  const [focused, setFocused] = createSignal<string>()
  const [pageEnd, setPageEnd] = createSignal<number>()
  const currentReasoning = () => {
    const last = props.batch.entries?.at(-1)
    return props.active && last?.kind === "reasoning" ? last.item.key : undefined
  }
  const reasoningAnchor = () => {
    const last = props.batch.entries?.at(-1)
    if (!props.active || last?.kind !== "reasoning") return undefined
    return props.batch.steps.at(-1)?.part.id
  }
  const current = createMemo(() => (currentReasoning() ? [] : activityBatchCurrentSteps(props.batch, props.active)))
  const reasoningAfterStep = createMemo(() => {
    const result = new Map<string, ActivityReasoningSummaryItem[]>()
    let preceding = ""
    for (const entry of props.batch.entries ?? []) {
      if (entry.kind === "tool") preceding = entry.step.part.id
      else result.set(preceding, [...(result.get(preceding) ?? []), entry.item])
    }
    return result
  })
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
  const window = createMemo(() =>
    activityBatchWindow(props.batch, pageEnd(), [...pinned(), ...(reasoningAnchor() ? [reasoningAnchor()!] : [])]),
  )
  const visible = createMemo(() => new Set(open() ? window().steps.map((step) => step.part.id) : pinned()))
  const label = () => (
    <ActivityBatchLabel
      batch={props.batch}
      total={props.batch.steps.length}
      identity={props.batch.key}
      live={props.active}
    />
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
  const triggerRef = createDisclosureMotionRef({
    visible: () => props.batch.steps.some((step) => step.state === "done" || step.state === "error") || !props.active,
    animate: () => false,
  })
  return (
    <div data-component="activity-batch" data-state={props.batch.state}>
      <button
        ref={triggerRef}
        data-slot="activity-batch-trigger"
        type="button"
        aria-expanded={open()}
        aria-controls={`${props.batch.key}:steps`}
        onClick={(event) => {
          props.onBeforeLayoutChange?.(event)
          const value = !open()
          if (props.view) props.view.setExpanded(props.batch.key, value)
          else setExplicit(value)
          if (value) props.onInspect?.()
        }}
      >
        <span>
          {label()}
          <ActivityBatchStatus label={props.active ? props.statusLabel : undefined} animated={props.statusAnimated} />
        </span>
        <Icon name={getSemanticIcon("navigation.expand")} size="small" />
      </button>
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
      <ProcessViewport
        identity={`${props.serverUrl}:${data.directory}:${props.batch.message.sessionID}:${props.batch.key}`}
        active={props.active}
        following={props.following}
        revision={props.batch.steps.map((step) => `${step.part.id}:${step.state}`).join(",")}
        onBeforeLayoutChange={props.onBeforeLayoutChange}
      >
        <ActivityTrace
          id={`${props.batch.key}:steps`}
          group={group()}
          serverUrl={props.serverUrl}
          visibleSteps={visible()}
          currentSteps={new Set(current())}
          quiet
          onStepFocus={setFocused}
          motion={props.following}
          afterStep={(partID) => (
            <For each={(reasoningAfterStep().get(partID) ?? []).map((item) => item.key)}>
              {(key) => {
                const item = () =>
                  reasoningAfterStep()
                    .get(partID)
                    ?.find((item) => item.key === key)
                return (
                  <Show when={item()}>
                    {(reasoning) => {
                      const reasoningRef = createDisclosureMotionRef({
                        visible: () =>
                          currentReasoning() === key ||
                          (open() && visible().has(partID)) ||
                          focused() === partID ||
                          (pinned().has(partID) && !props.following),
                        animate: () => props.following,
                        content: true,
                      })
                      return (
                        <li
                          data-slot="activity-reasoning"
                          data-part-id={reasoning().partID}
                          ref={reasoningRef}
                          onFocusIn={() => setFocused(partID)}
                          onFocusOut={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(undefined)
                          }}
                        >
                          <ActivityReasoning
                            item={reasoning()}
                            working={props.active}
                            preview={props.reasoningPreview === true}
                            view={props.view}
                            onInspect={props.onInspect}
                          />
                        </li>
                      )
                    }}
                  </Show>
                )
              }}
            </For>
          )}
        />
      </ProcessViewport>
    </div>
  )
}

export { ProcessReasoning } from "./process-reasoning"
