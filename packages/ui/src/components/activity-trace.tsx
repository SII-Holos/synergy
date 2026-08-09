import type { MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import { createEffect, createMemo, createSignal, For, lazy, on, onCleanup, Show } from "solid-js"
import {
  finishActivityCountTransition,
  reduceActivityCountTransition,
  type ActivityCountTransition,
} from "./activity-count-transition"
import { Collapsible } from "./collapsible"
import { specializedActivityDetail } from "./activity-specialized-detail-model"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { Spinner } from "./spinner"
import { ToolResultBody } from "./tool-result-body"
import type {
  ActivityFamily,
  ActivityGroupItem,
  ActivityGroupState,
  ActivityReasoningSummaryItem,
  ActivityReceiptItem,
  ActivityStepProjection,
  ActivitySummaryItem,
} from "./session-turn-activity"
import "./activity-trace.css"

const TRANSITION_MS = 160
const ActivitySpecializedDetail = lazy(() =>
  import("./activity-specialized-detail").then((module) => ({ default: module.ActivitySpecializedDetail })),
)

function d(id: string, message: string): MessageDescriptor {
  return { id, message }
}

export const ACTIVITY_TRACE_DESC = {
  activity: d("activity.trace.activity", "Activity"),
  actions: d("activity.trace.actions", "{count, plural, one {# action} other {# actions}}"),
  stepCount: d("activity.trace.steps", "{count, plural, one {# step} other {# steps}}"),
  status: {
    running: d("activity.trace.status.running", "Running"),
    done: d("activity.trace.status.done", "Done"),
    error: d("activity.trace.status.error", "Failed"),
    waitingApproval: d("activity.trace.status.waiting-approval", "Waiting for approval"),
  },
  family: {
    "inspect-local": d("activity.trace.family.inspect-local", "Inspected"),
    "research-web": d("activity.trace.family.research-web", "Researched"),
    "modify-files": d("activity.trace.family.modify-files", "Changed"),
    execute: d("activity.trace.family.execute", "Ran"),
    browser: d("activity.trace.family.browser", "Browsed"),
    delegate: d("activity.trace.family.delegate", "Delegated"),
    produce: d("activity.trace.family.produce", "Produced"),
    "external-action": d("activity.trace.family.external-action", "External action"),
    coordination: d("activity.trace.family.coordination", "Coordinated"),
    generic: d("activity.trace.family.generic", "Worked"),
  },
} as const

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function AnimatedActivityCount(props: { value: number; identity: string }) {
  const [state, setState] = createSignal<ActivityCountTransition>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancelTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  createEffect(
    on(
      () => [props.identity, props.value] as const,
      ([identity, value]) => {
        cancelTimer()
        const next = reduceActivityCountTransition(state(), {
          identity,
          value,
          reducedMotion: prefersReducedMotion(),
        })
        setState(next)
        if (!next.animating) return
        const revision = next.revision
        timer = setTimeout(() => {
          setState((current) => (current ? finishActivityCountTransition(current, revision) : current))
          timer = undefined
        }, TRANSITION_MS)
      },
    ),
  )

  onCleanup(cancelTimer)

  return (
    <span
      data-component="animated-activity-count"
      data-animating={state()?.animating ? "" : undefined}
      aria-label={String(props.value)}
    >
      <span data-slot="activity-count-grid" aria-hidden="true">
        <Show when={state()?.animating && state()?.previous !== undefined}>
          <span data-slot="activity-count-old">{state()?.previous}</span>
        </Show>
        <span data-slot="activity-count-new">{state()?.current ?? props.value}</span>
      </span>
    </span>
  )
}

function localize(value: string | MessageDescriptor, translate: (descriptor: MessageDescriptor) => string): string {
  return typeof value === "string" ? value : translate(value)
}

function stateDescriptor(state: ActivityGroupState): MessageDescriptor {
  if (state === "waiting-approval") return ACTIVITY_TRACE_DESC.status.waitingApproval
  return ACTIVITY_TRACE_DESC.status[state]
}

function familyIcon(family: ActivityFamily) {
  switch (family) {
    case "inspect-local":
      return "glasses" as const
    case "research-web":
      return "globe" as const
    case "modify-files":
      return "file-pen" as const
    case "execute":
      return "terminal" as const
    case "browser":
      return "compass" as const
    case "delegate":
      return "bot" as const
    case "produce":
      return "sparkles" as const
    case "external-action":
      return "external-link" as const
    case "coordination":
      return "list-checks" as const
    case "generic":
      return "activity" as const
  }
}

function stateIcon(state: ActivityGroupState) {
  if (state === "error") return getSemanticIcon("state.error")
  if (state === "waiting-approval") return getSemanticIcon("state.warning")
  return getSemanticIcon("state.success")
}

function ActivityState(props: { state: ActivityGroupState; label: string }) {
  return (
    <span data-slot="activity-state" data-state={props.state}>
      <Show when={props.state === "running"} fallback={<Icon name={stateIcon(props.state)} size="small" />}>
        <Spinner />
      </Show>
      <span>{props.label}</span>
    </span>
  )
}

function ActivityStep(props: { step: ActivityStepProjection; serverUrl: string }) {
  const { _ } = useLingui()
  const title = createMemo(() => localize(props.step.title, _))
  const stateLabel = createMemo(() => _(stateDescriptor(props.step.state)))
  return (
    <li data-slot="activity-step" data-state={props.step.state}>
      <div data-slot="activity-step-row">
        <span data-slot="activity-step-icon" aria-hidden="true">
          <Icon name={props.step.icon} size="small" />
        </span>
        <div data-slot="activity-step-copy">
          <span data-slot="activity-step-title">{title()}</span>
          <Show when={props.step.subtitle}>
            {(subtitle) => <span data-slot="activity-step-subtitle">{subtitle()}</span>}
          </Show>
        </div>
        <ActivityState state={props.step.state} label={stateLabel()} />
      </div>
      <ToolResultBody
        part={props.step.part}
        serverUrl={props.serverUrl}
        sessionId={props.step.part.sessionID}
        messageId={props.step.part.messageID}
        resultOnly
      />
    </li>
  )
}

export function ActivityReasoningSummary(props: { item: ActivityReasoningSummaryItem }) {
  const { _ } = useLingui()
  const terminal = createMemo(() => props.item.state === "stable" || props.item.state === "fallback")
  const thinkingText = createMemo(() => _({ id: "activity.trace.reasoning.thinking", message: "Thinking…" }))
  const reasoningText = createMemo(() => _({ id: "activity.trace.reasoning.fallback", message: "Reasoning" }))
  const text = createMemo(() => {
    const stored = props.item.text?.trim()
    if (stored) return stored
    return props.item.state === "pending" ? thinkingText() : reasoningText()
  })

  return (
    <div
      data-component="reasoning-summary"
      data-summary-state={props.item.state}
      data-summary-source={props.item.source}
      role={terminal() ? "status" : undefined}
      aria-live={terminal() ? "polite" : "off"}
    >
      <span data-slot="reasoning-summary-leading" aria-hidden="true">
        <Show
          when={props.item.state === "pending"}
          fallback={<Icon name={getSemanticIcon("performance.trace")} size="small" />}
        >
          <Spinner />
        </Show>
      </span>
      <span data-slot="reasoning-summary-text">{text()}</span>
    </div>
  )
}

function ActivityTraceMarker(props: { state: ActivityGroupState; label: string }) {
  return (
    <span
      role="img"
      data-slot="activity-trace-marker"
      data-state={props.state}
      data-motion={props.state === "running" ? "breathing" : "static"}
      aria-label={props.label}
    >
      <Show when={props.state !== "running"}>
        <Icon name={stateIcon(props.state)} size="small" />
      </Show>
    </span>
  )
}

export function ActivityTrace(props: { group: ActivityGroupItem; serverUrl: string }) {
  const { _ } = useLingui()
  const [open, setOpen] = createSignal(false)
  const familyLabel = createMemo(() => _(ACTIVITY_TRACE_DESC.family[props.group.family]))
  const stepCount = createMemo(() =>
    _({ ...ACTIVITY_TRACE_DESC.stepCount, values: { count: props.group.steps.length } }),
  )
  const stateLabel = createMemo(() => _(stateDescriptor(props.group.state)))

  return (
    <div data-component="activity-trace" data-family={props.group.family} data-state={props.group.state}>
      <span data-slot="activity-trace-connector" aria-hidden="true" />
      <Collapsible open={open()} onOpenChange={setOpen} variant="ghost">
        <Collapsible.Trigger data-slot="activity-trace-trigger" type="button">
          <ActivityTraceMarker state={props.group.state} label={stateLabel()} />
          <span data-slot="activity-trace-copy">
            <span data-slot="activity-trace-heading">
              <span data-slot="activity-trace-title">{familyLabel()}</span>
              <Show when={props.group.scopeLabel}>
                {(scope) => <span data-slot="activity-trace-scope">{scope()}</span>}
              </Show>
            </span>
            <Show when={props.group.summary?.text}>
              {(summary) => (
                <span data-slot="activity-trace-summary" data-summary-state={props.group.summary?.state}>
                  {summary()}
                </span>
              )}
            </Show>
          </span>
          <span data-slot="activity-trace-meta">
            <span>{stepCount()}</span>
            <Icon
              name={open() ? getSemanticIcon("navigation.collapse") : getSemanticIcon("navigation.expand")}
              size="small"
            />
          </span>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <ol data-slot="activity-step-list">
            <For each={props.group.steps}>{(step) => <ActivityStep step={step} serverUrl={props.serverUrl} />}</For>
          </ol>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

function ActivityReceiptRow(props: {
  group: ActivityGroupItem
  step: ActivityStepProjection | undefined
  title: string
  stateLabel: string
  expandable?: boolean
  open?: boolean
}) {
  return (
    <div data-slot="activity-receipt-row">
      <span data-slot="activity-receipt-icon" aria-hidden="true">
        <Icon name={familyIcon(props.group.family)} size="small" />
      </span>
      <span data-slot="activity-receipt-title">{props.title}</span>
      <Show when={props.step?.subtitle}>
        {(subtitle) => <span data-slot="activity-receipt-scope">{subtitle()}</span>}
      </Show>
      <ActivityState state={props.group.state} label={props.stateLabel} />
      <Show when={props.expandable}>
        <Icon
          name={props.open ? getSemanticIcon("navigation.collapse") : getSemanticIcon("navigation.expand")}
          size="small"
        />
      </Show>
    </div>
  )
}

export function ActivityReceipt(props: { item: ActivityReceiptItem; serverUrl: string }) {
  const { _ } = useLingui()
  const [open, setOpen] = createSignal(false)
  const step = createMemo(() => props.item.group.steps[0])
  const detail = createMemo(() => {
    const value = step()
    return value ? specializedActivityDetail(value) : undefined
  })
  const title = createMemo(() => {
    const value = step()
    return value ? localize(value.title, _) : _(ACTIVITY_TRACE_DESC.family[props.item.group.family])
  })
  const stateLabel = createMemo(() => _(stateDescriptor(props.item.group.state)))
  return (
    <div data-component="activity-receipt" data-state={props.item.group.state}>
      <Show
        when={detail()}
        fallback={
          <ActivityReceiptRow group={props.item.group} step={step()} title={title()} stateLabel={stateLabel()} />
        }
      >
        {(value) => (
          <Collapsible open={open()} onOpenChange={setOpen} variant="ghost">
            <Collapsible.Trigger data-slot="activity-receipt-trigger" type="button">
              <ActivityReceiptRow
                group={props.item.group}
                step={step()}
                title={title()}
                stateLabel={stateLabel()}
                expandable
                open={open()}
              />
            </Collapsible.Trigger>
            <Collapsible.Content>
              <ActivitySpecializedDetail detail={value()} />
            </Collapsible.Content>
          </Collapsible>
        )}
      </Show>
    </div>
  )
}

export function MinimalActivitySummary(props: { item: ActivitySummaryItem }) {
  const { _ } = useLingui()
  const finalLabel = createMemo(() => {
    const actions = _({ ...ACTIVITY_TRACE_DESC.actions, values: { count: props.item.total } })
    const facts = props.item.facts.map(
      (fact) => `${_(ACTIVITY_TRACE_DESC.family[fact.family]).toLocaleLowerCase()} ${fact.count}`,
    )
    return [actions, ...facts].join(" · ")
  })

  return (
    <div
      data-component="minimal-activity-summary"
      role={props.item.completed ? "status" : undefined}
      aria-live={props.item.completed ? "polite" : "off"}
      aria-label={finalLabel()}
    >
      <span data-slot="minimal-activity-leading" aria-hidden="true">
        <Icon name={getSemanticIcon("performance.trace")} size="small" />
      </span>
      <span data-slot="minimal-activity-fact" aria-hidden="true">
        <AnimatedActivityCount value={props.item.total} identity={props.item.key} />
        <span>{_(ACTIVITY_TRACE_DESC.activity)}</span>
      </span>
      <For each={props.item.facts}>
        {(fact) => (
          <>
            <span data-slot="minimal-activity-separator" aria-hidden="true">
              ·
            </span>
            <span data-slot="minimal-activity-fact" aria-hidden="true">
              <span>{_(ACTIVITY_TRACE_DESC.family[fact.family]).toLocaleLowerCase()}</span>
              <AnimatedActivityCount value={fact.count} identity={`${props.item.key}:${fact.family}`} />
            </span>
          </>
        )}
      </For>
      <Show when={props.item.now?.text}>
        {(now) => (
          <span data-slot="minimal-activity-now" aria-hidden="true">
            {now()}
          </span>
        )}
      </Show>
    </div>
  )
}
