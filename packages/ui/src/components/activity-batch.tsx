import type { PluginConversationActivityView } from "@ericsanchezok/synergy-plugin"
import { useLingui } from "@lingui/solid"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { ActivityTrace } from "./activity-trace"
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
export function ActivityBatchLabel(props: {
  batch: Pick<
    ActivityBatchItem,
    "facts" | "fileReads" | "fileReadOperations" | "searchOperations" | "inspectionOperations"
  >
  total: number
}) {
  const { _ } = useLingui()
  const countedFact = (descriptor: MessageDescriptor, count: number) => _({ ...descriptor, values: { count } })
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
    return labels
  }
  const label = createMemo(() => {
    const labels = props.batch.facts
      .filter((fact) => fact.count > 0)
      .flatMap((fact) => {
        const inspection = fact.family === "inspect-local" ? inspectionLabel() : []
        return inspection.length ? inspection : [countedFact(facts[fact.family], fact.count)]
      })
    const total = countedFact(
      { id: "session.activity.operations", message: "{count, plural, one {# action} other {# actions}}" },
      props.total,
    )
    if (!labels.length) return total
    const incomplete = props.batch.facts.reduce((sum, fact) => sum + fact.count, 0) < props.total
    return [...labels.slice(0, 2), ...(labels.length > 2 || incomplete ? [total] : [])].join(" · ")
  })
  return <>{label()}</>
}

export function ActivityBatch(props: {
  batch: ActivityBatchItem
  serverUrl: string
  mode: ActivityDisplayMode
  active: boolean
  following: boolean
  reasoningPreview?: boolean
  view?: PluginConversationActivityView
  onInspect?: () => void
}) {
  const { _ } = useLingui()
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
  const label = () => <ActivityBatchLabel batch={props.batch} total={props.batch.steps.length} />
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
    animate: () => props.following,
  })
  return (
    <div data-component="activity-batch" data-state={props.batch.state}>
      <button
        ref={triggerRef}
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
        identity={props.batch.key}
        active={props.active}
        following={props.following}
        revision={props.batch.steps.map((step) => `${step.part.id}:${step.state}`).join(",")}
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
                        appear: () => props.active && currentReasoning() === key,
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
