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
import { Icon, type IconName } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { Spinner } from "./spinner"
import { ToolResultBody } from "./tool-result-body"
import { Tooltip } from "./tooltip"
import { getApprovalAudit } from "../utils/approval-audit"
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

function familyDescriptor(family: ActivityFamily): MessageDescriptor {
  switch (family) {
    case "inspect-local":
      return ACTIVITY_TRACE_DESC.family["inspect-local"]
    case "research-web":
      return ACTIVITY_TRACE_DESC.family["research-web"]
    case "modify-files":
      return ACTIVITY_TRACE_DESC.family["modify-files"]
    case "execute":
      return ACTIVITY_TRACE_DESC.family.execute
    case "browser":
      return ACTIVITY_TRACE_DESC.family.browser
    case "delegate":
      return ACTIVITY_TRACE_DESC.family.delegate
    case "produce":
      return ACTIVITY_TRACE_DESC.family.produce
    case "external-action":
      return ACTIVITY_TRACE_DESC.family["external-action"]
    case "coordination":
      return ACTIVITY_TRACE_DESC.family.coordination
    case "generic":
      return ACTIVITY_TRACE_DESC.family.generic
  }
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
  const { i18n, _ } = useLingui()
  const [open, setOpen] = createSignal(false)
  const familyLabel = createMemo(() => localize(familyDescriptor(props.step.family), _))
  const title = createMemo(() => localize(props.step.title, _))
  const stateLabel = createMemo(() => _(stateDescriptor(props.step.state)))
  const approval = createMemo(() => {
    const metadata = props.step.part.state.metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
    return (metadata as Record<string, unknown>).approval as Record<string, unknown> | undefined
  })
  const audit = createMemo(() => getApprovalAudit(approval(), i18n()))
  return (
    <li data-slot="activity-step" data-family={props.step.family} data-state={props.step.state}>
      <Show when={audit().icon}>
        <Tooltip
          placement="right"
          class="activity-step-audit-trigger"
          value={
            <div class="max-w-72">
              <div class="text-12-medium text-text-base">{audit().tooltip.split("\n")[0]}</div>
              <Show when={audit().tooltip.includes("\n")}>
                <div class="mt-1 text-11-regular text-text-weak">{audit().tooltip.split("\n").slice(1).join("\n")}</div>
              </Show>
            </div>
          }
        >
          <span
            data-component="tool-audit-icon"
            data-slot="activity-step-audit-icon"
            tabindex="0"
            role="img"
            aria-label={audit().tooltip}
          >
            <Icon name={audit().icon as IconName} size="small" class={audit().iconClass} />
          </span>
        </Tooltip>
      </Show>
      <Collapsible open={open()} onOpenChange={setOpen} variant="ghost">
        <Collapsible.Trigger data-slot="activity-step-trigger" type="button">
          <span data-slot="activity-step-icon" aria-hidden="true">
            <Icon name={props.step.icon} size="small" />
          </span>
          <div data-slot="activity-step-copy">
            <span data-slot="activity-step-family">{familyLabel()}</span>
            <span data-slot="activity-step-title" title={title()}>
              {title()}
            </span>
            <Show when={props.step.subtitle}>
              {(subtitle) => (
                <span data-slot="activity-step-subtitle" title={subtitle()}>
                  {subtitle()}
                </span>
              )}
            </Show>
          </div>
          <ActivityState state={props.step.state} label={stateLabel()} />
          <Icon
            name={open() ? getSemanticIcon("navigation.collapse") : getSemanticIcon("navigation.expand")}
            size="small"
          />
        </Collapsible.Trigger>
        <Collapsible.Content>
          <ToolResultBody
            part={props.step.part}
            serverUrl={props.serverUrl}
            sessionId={props.step.part.sessionID}
            messageId={props.step.part.messageID}
            resultOnly
            defaultOpen
          />
        </Collapsible.Content>
      </Collapsible>
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

export function ActivityTrace(props: { group: ActivityGroupItem; serverUrl: string }) {
  const emptyStepSnapshot = {
    keys: [] as string[],
    map: new Map<string, ActivityStepProjection>(),
  }
  const stepSnapshot = createMemo(() => {
    const keys: string[] = []
    const map = new Map<string, ActivityStepProjection>()
    for (const step of props.group.steps) {
      keys.push(step.part.id)
      map.set(step.part.id, step)
    }
    return { keys, map }
  }, emptyStepSnapshot)

  return (
    <div data-component="activity-trace">
      <ol data-slot="activity-step-list">
        <For each={stepSnapshot().keys}>
          {(key) => {
            const step = () => stepSnapshot().map.get(key)
            return (
              <Show when={step()}>{(current) => <ActivityStep step={current()} serverUrl={props.serverUrl} />}</Show>
            )
          }}
        </For>
      </ol>
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
      <span data-slot="activity-receipt-title" title={props.title}>
        {props.title}
      </span>
      <Show when={props.step?.subtitle}>
        {(subtitle) => (
          <span data-slot="activity-receipt-scope" title={subtitle()}>
            {subtitle()}
          </span>
        )}
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
