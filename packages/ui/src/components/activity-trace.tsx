import type { MessageDescriptor } from "@lingui/core"
import { attachmentPurpose } from "@ericsanchezok/synergy-util/attachment-presentation"
import { AttachmentGallery } from "./attachment-card"
import { useLingui } from "@lingui/solid"
import { useResourceOpen } from "../context/resource-open"
import { useData } from "../context/data"
import { createEffect, createMemo, createSignal, For, lazy, on, onCleanup, Show, type JSX } from "solid-js"
import { createDisclosureMotionRef } from "../utils/disclosure-motion"
import { useConversationMotion } from "./conversation-motion"
import {
  finishActivityCountTransition,
  reduceActivityCountTransition,
  type ActivityCountTransition,
} from "./activity-count-transition"
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import { Dialog } from "./dialog"
import { Collapsible } from "./collapsible"
import { specializedActivityDetail } from "./activity-specialized-detail-model"
import { DiffChanges } from "./diff-changes"
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
    execute: d("activity.trace.family.execute", "Run command"),
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
      return "file-text" as const
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

function ActivityStep(props: {
  step: ActivityStepProjection
  serverUrl: string
  hidden?: boolean
  current?: boolean
  quiet?: boolean
  motion?: boolean
  onFocus?: (partID: string | undefined) => void
}) {
  const { i18n, _ } = useLingui()
  const [open, setOpen] = createSignal(false)
  const resources = useResourceOpen()
  const data = useData()
  const [responding, setResponding] = createSignal(false)
  const [responseError, setResponseError] = createSignal<string>()
  const request = () =>
    data.view
      .permissionsFor(props.step.part.sessionID)
      .find(
        (request) =>
          request.tool?.messageID === props.step.part.messageID && request.tool.callID === props.step.part.callID,
      )
  createEffect(
    on(
      () => request()?.id,
      () => {
        setResponding(false)
        setResponseError(undefined)
      },
    ),
  )
  const respond = async (response: "once" | "reject") => {
    const selected = request()
    if (!selected || responding() || !data.respondToPermission) return
    setResponding(true)
    try {
      await data.respondToPermission({ sessionID: props.step.part.sessionID, permissionID: selected.id, response })
    } catch (error) {
      setResponseError(error instanceof Error ? error.message : String(error))
      setResponding(false)
    }
  }
  const title = createMemo(() => localize(props.step.title, _))
  const evidence = createMemo(() => {
    const state = props.step.part.state
    return state.status === "completed"
      ? (state.attachments ?? []).filter((file) => !file.presentation?.hidden && attachmentPurpose(file) === "evidence")
      : []
  })
  // Provenance: docs/decisions/implemented/feature/2026-10-04-semantic-process-disclosure.md
  // Local adaptation: registered targets lead; invocation identity still opens the existing result owner.
  const target = () => props.step.subtitle?.trim()
  const object = () => (target() && !title().includes(target()!) ? target() : undefined)
  const label = () =>
    object() ? `${title()} · ${object()}` : target() ? title() : props.step.part.workBrief?.trim() || title()
  const pathParts = () => {
    const value = object() ?? ""
    const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1
    return [value.slice(0, index), value.slice(index)]
  }
  const stateLabel = createMemo(() => _(stateDescriptor(props.step.state)))
  const approval = createMemo(() => {
    const metadata = props.step.part.state.metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
    return (metadata as Record<string, unknown>).approval as Record<string, unknown> | undefined
  })
  const audit = createMemo(() => getApprovalAudit(approval(), i18n()))
  const takeArrival = useConversationMotion()
  const motionRef = createDisclosureMotionRef({
    visible: () => props.hidden !== true,
    animate: () => props.motion !== false,
    content: true,
    appear: () => props.hidden !== true && takeArrival(props.step.part.id),
  })
  return (
    <li
      data-slot="activity-step"
      data-part-id={props.step.part.id}
      data-family={props.step.family}
      data-state={props.step.state}
      data-current={props.current ? "" : undefined}
      data-working={props.current && props.step.state === "running" ? "" : undefined}
      ref={motionRef}
      onFocusIn={() => props.onFocus?.(props.step.part.id)}
      onFocusOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onFocus?.(undefined)
      }}
    >
      <Show when={props.step.state === "error" && audit().icon}>
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
      <button
        data-slot="activity-step-trigger"
        type="button"
        aria-label={`${label()} · ${stateLabel()}`}
        aria-pressed={
          resources?.isToolActivitySelected?.(
            {
              sessionID: props.step.part.sessionID,
              messageID: props.step.part.messageID,
              partID: props.step.part.id,
              callID: props.step.part.callID,
            },
            props.step.part,
          ) ?? open()
        }
        onClick={() => {
          if (
            !resources?.openToolActivity?.(
              {
                sessionID: props.step.part.sessionID,
                messageID: props.step.part.messageID,
                partID: props.step.part.id,
                callID: props.step.part.callID,
              },
              props.step.part,
            )
          )
            setOpen(true)
        }}
      >
        <span data-slot="activity-step-icon" aria-hidden="true">
          <Icon name={props.step.icon} size="small" />
        </span>
        <span data-slot="activity-step-copy">
          <span data-slot="activity-step-title" data-object={object() ? "" : undefined} title={label()}>
            <Show when={object()} fallback={label()}>
              <span data-slot="activity-step-action">{title()}</span>
              <span data-slot="activity-step-object" data-kind={props.step.objectKind}>
                <Show when={props.step.objectKind === "path"} fallback={object()}>
                  <span data-slot="activity-step-directory">{pathParts()[0]}</span>
                  <span data-slot="activity-step-filename">{pathParts()[1]}</span>
                </Show>
              </span>
            </Show>
          </span>
        </span>
        <Show when={props.step.changes}>{(changes) => <DiffChanges changes={changes()} />}</Show>
        <Show when={props.step.state === "error" && !audit().icon}>
          <span data-slot="activity-step-error" aria-hidden="true">
            <Icon name={getSemanticIcon("state.error")} size="small" />
          </span>
        </Show>
        <Show when={(!props.quiet && props.step.state === "running") || props.step.state === "waiting-approval"}>
          <ActivityState state={props.step.state} label={stateLabel()} />
        </Show>
      </button>
      <Show when={evidence().length > 0}>
        <div data-slot="activity-evidence">
          <AttachmentGallery files={evidence()} serverUrl={props.serverUrl} compact="process" layout="rows" />
        </div>
      </Show>
      <Show when={request() && data.respondToPermission}>
        <div data-slot="activity-approval-actions">
          <button type="button" disabled={responding()} onClick={() => void respond("once")}>
            {_({ id: "activity.approval.allowOnce", message: "Allow once" })}
          </button>
          <button type="button" disabled={responding()} onClick={() => void respond("reject")}>
            {_({ id: "activity.approval.reject", message: "Decline" })}
          </button>
          <Show when={responseError()}>{(error) => <span role="alert">{error()}</span>}</Show>
        </div>
      </Show>
      <KobalteDialog open={open()} onOpenChange={setOpen}>
        <Show when={open()}>
          <KobalteDialog.Portal>
            <Dialog title={label()} size="wide">
              <ToolResultBody
                part={props.step.part}
                serverUrl={props.serverUrl}
                sessionId={props.step.part.sessionID}
                messageId={props.step.part.messageID}
                resultOnly
                defaultOpen
              />
            </Dialog>
          </KobalteDialog.Portal>
        </Show>
      </KobalteDialog>
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

export function ActivityTrace(props: {
  group: ActivityGroupItem
  serverUrl: string
  id?: string
  visibleSteps?: ReadonlySet<string>
  currentSteps?: ReadonlySet<string>
  quiet?: boolean
  onStepFocus?: (partID: string | undefined) => void
  motion?: boolean
  afterStep?: (partID: string) => JSX.Element
}) {
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
      <ol id={props.id} data-slot="activity-step-list">
        <For each={stepSnapshot().keys}>
          {(key) => {
            const step = () => stepSnapshot().map.get(key)
            return (
              <>
                <Show when={step()}>
                  {(current) => (
                    <ActivityStep
                      step={current()}
                      serverUrl={props.serverUrl}
                      hidden={props.visibleSteps !== undefined && !props.visibleSteps.has(key)}
                      current={props.currentSteps?.has(key)}
                      quiet={props.quiet}
                      onFocus={props.onStepFocus}
                      motion={props.motion}
                    />
                  )}
                </Show>
                {props.afterStep?.(key)}
              </>
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
    </div>
  )
}
