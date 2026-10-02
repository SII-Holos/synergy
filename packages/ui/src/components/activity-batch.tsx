import type { PluginConversationActivityView } from "@ericsanchezok/synergy-plugin"
import { useLingui } from "@lingui/solid"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { ActivityTrace } from "./activity-trace"
import { Collapsible } from "./collapsible"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import type { ActivityBatchItem, ActivityDisplayMode, ActivityFamily } from "./session-turn-activity"
import { resolveActivityDisclosure } from "./session-turn-process"
import type { MessageDescriptor } from "@lingui/core"
import { compactReasoningFirstLine } from "./compact-reasoning-text"
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
const workingPhase: MessageDescriptor = { id: "activity.phase.working", message: "Working" }
const phases: Record<ActivityFamily, MessageDescriptor> = {
  produce: workingPhase,
  "external-action": workingPhase,
  coordination: workingPhase,
  generic: workingPhase,
  "inspect-local": { id: "activity.phase.read", message: "Reading files" },
  execute: { id: "activity.phase.command", message: "Running a command" },
  "modify-files": { id: "activity.phase.modify", message: "Updating files" },
  "research-web": { id: "activity.phase.research", message: "Researching sources" },
  browser: { id: "activity.phase.browser", message: "Using the browser" },
  delegate: { id: "activity.phase.delegate", message: "Working with a subagent" },
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
  const phaseLabel = (descriptor: MessageDescriptor) => _(descriptor)
  const countedFact = (descriptor: MessageDescriptor, count: number) => _({ ...descriptor, values: { count } })
  const [explicit, setExplicit] = createSignal<boolean>()
  const [heldOpen, setHeldOpen] = createSignal(false)
  createEffect(
    on(
      () => props.active,
      (active, previous) => {
        if (previous && !active && !props.following) setHeldOpen(true)
      },
    ),
  )
  createEffect(() => {
    if (props.following) setHeldOpen(false)
  })
  const open = () =>
    resolveActivityDisclosure({
      mode: props.mode,
      working: props.active,
      heldOpen: heldOpen(),
      explicit: props.view?.getExpanded(props.batch.key) ?? explicit(),
    })
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
    props.batch.state === "running"
      ? (() => {
          const step = props.batch.steps.findLast((step) => step.state === "running")
          if (step?.part.state.status === "generating" || step?.part.state.status === "pending")
            return _({ id: "activity.phase.prepare", message: "Preparing an action" })
          return phaseLabel(phases[step?.family ?? "generic"])
        })()
      : props.batch.facts.length
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
    steps: props.batch.steps,
    receipt: false,
  }))
  return (
    <div data-component="activity-batch" data-state={props.batch.state}>
      <Collapsible
        open={open()}
        onOpenChange={(value) => {
          if (props.view) props.view.setExpanded(props.batch.key, value)
          else setExplicit(value)
          if (value) props.onInspect?.()
        }}
        variant="ghost"
      >
        <Collapsible.Trigger data-slot="activity-batch-trigger" type="button">
          <Show when={props.active && props.batch.state === "running"}>
            <span data-slot="activity-live-indicator" aria-hidden="true" />
          </Show>
          <span>{label()}</span>
          <Icon name={getSemanticIcon("navigation.expand")} size="small" />
        </Collapsible.Trigger>
        <Collapsible.Content>
          <ActivityTrace group={group()} serverUrl={props.serverUrl} />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

export function ProcessReasoning(props: {
  entries: readonly import("@ericsanchezok/synergy-sdk/client").ReasoningPart[]
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
        <span data-slot="process-reasoning-preview">{compactReasoningFirstLine(text())}</span>
      </Show>
      <div id={`${props.identity}:detail`} data-slot="process-reasoning-detail" hidden={!open()}>
        <For each={props.entries.map((part) => part.id)}>
          {(id) => <div data-reasoning-part={id}>{props.entries.find((part) => part.id === id)?.text}</div>}
        </For>
      </div>
    </div>
  )
}
