import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionNodeDetail } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSDK } from "@/context/sdk"
import { useNavigateToSession } from "@/composables/use-navigate-to-session"
import { E, K } from "./i18n"
import { createExecutionClock } from "@/composables/create-execution-clock"
import { EvidenceReader } from "./reader"
import { EvidenceBlock } from "./block"

type Tab = "result" | "diagnostics" | "request" | "response" | "calls"
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}

export function ExecutionInspector(props: {
  sessionID: string
  nodeID: string
  revision: number
  runID?: string
  executor?: string
  onBack: () => void
  onSelect: (id: string) => void
  filtered?: boolean
}) {
  const { _, i18n } = useLingui()
  const sdk = useSDK()
  const navigate = useNavigateToSession()
  const [detail, setDetail] = createSignal<ExecutionNodeDetail>()
  const [fresh, setFresh] = createSignal(false)
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden")
  const advance = createExecutionClock(
    () => detail()?.execution,
    () => sdk.connected() && fresh() && visible(),
  )
  const elapsed = () => {
    const execution = detail()?.execution
    if (execution)
      return execution.elapsedMs == null
        ? null
        : executionDuration(
            execution.elapsedMs + (execution.elapsedActive ? advance() : 0),
            execution.elapsedLowerBound,
          )
    const node = detail()?.node
    if (!node || node.kind === "turn" || node.kind === "subtask" || node.ended == null) return null
    return executionDuration(node.ended - node.started)
  }
  const [tab, setTab] = createSignal<Tab>("result")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  let abort: AbortController | undefined
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const record = () => object(detail()?.record)
  const sources = () => detail()?.sources.map((source) => source.field) ?? []
  const failure = () => (typeof record().error === "string" ? (record().error as string) : "")
  const isModel = () =>
    ["call", "attempt"].includes(detail()?.node.evidenceKind ?? "") ||
    ["model", "retry", "compaction"].includes(detail()?.node.kind ?? "")
  const tabs = createMemo<Tab[]>(() => {
    const value = detail()
    if (!value || value.node.source === "messages") return []
    if (isModel())
      return [
        ...((value.node.group?.callCount ?? 0) > 1 ? ["calls" as const] : []),
        ...(sources().includes("request") ? ["request" as const] : []),
        ...(sources().includes("response") ? ["response" as const] : []),
      ]
    return ["tool", "process"].includes(value.node.kind) ? ["result", "diagnostics"] : []
  })
  const results = () => sources().filter((field) => ["rawResult", "observation", "stream"].includes(field))
  const physical = () =>
    detail()
      ?.related.filter((node) => node.evidenceKind === "attempt")
      .toSorted((a, b) => (a.attemptIndex ?? 0) - (b.attemptIndex ?? 0)) ?? []
  const calls = () =>
    detail()?.related.filter((node) => node.evidenceKind === "call" && node.runID === detail()?.node.runID) ?? []
  const load = async (reset = false) => {
    abort?.abort()
    abort = new AbortController()
    const controller = abort
    const version = ++generation
    setLoading(true)
    setError(false)
    try {
      const response = await sdk.client.session.executionNode(
        { sessionID: props.sessionID, nodeID: props.nodeID, runID: props.runID },
        { signal: controller.signal, throwOnError: true },
      )
      if (disposed || version !== generation) return
      setFresh(true)
      setDetail(response.data)
      if (reset || (tabs().length && !tabs().includes(tab()))) setTab(tabs()[0] ?? "result")
    } catch {
      if (!disposed && version === generation && !controller.signal.aborted) setError(true)
    } finally {
      if (!disposed && version === generation) setLoading(false)
    }
  }
  createEffect(
    on(
      () => props.nodeID,
      () => {
        setDetail(undefined)
        void load(true)
      },
    ),
  )
  createEffect(
    on(
      sdk.connected,
      (connected) => {
        setFresh(false)
        if (connected && detail()) void load()
      },
      { defer: true },
    ),
  )
  const visibility = () => {
    setVisible(document.visibilityState !== "hidden")
    setFresh(false)
    if (document.visibilityState === "visible" && sdk.connected()) void load()
  }
  document.addEventListener("visibilitychange", visibility)
  createEffect(
    on(
      () => props.revision,
      () => {
        clearTimeout(timer)
        if (detail()) timer = setTimeout(() => void load(), 500)
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    document.removeEventListener("visibilitychange", visibility)
    disposed = true
    generation++
    abort?.abort()
    clearTimeout(timer)
  })
  const formatTime = (value: number | undefined) =>
    value == null
      ? _(E.unknown)
      : new Intl.DateTimeFormat(i18n().locale, { dateStyle: "medium", timeStyle: "medium" }).format(value)
  const reader = (field: string, label: string) => (
    <EvidenceReader
      sessionID={props.sessionID}
      nodeID={props.nodeID}
      field={field}
      label={label}
      runID={props.runID}
      revision={detail()?.sources.find((source) => source.field === field)?.artifact.bytes ?? 0}
    />
  )
  const timing = () => (
    <section class="execution-diagnostics-section" aria-label={_(E.timing)}>
      <h3>{_(E.timing)}</h3>
      <dl class="execution-detail-rows">
        <div>
          <dt>{_(E.actor)}</dt>
          <dd>
            {props.executor ||
              detail()?.node.agent ||
              (detail()?.node.sessionID === props.sessionID
                ? _(E.own)
                : detail()?.node.ancestors?.findLast((ancestor) => ancestor.kind === "subtask")?.title ||
                  (detail()?.node.kind === "subtask" ? detail()?.node.title : _(E.children)))}
          </dd>
        </div>
        <div>
          <dt>{_(E.start)}</dt>
          <dd>{formatTime(detail()?.node.started)}</dd>
        </div>
        <Show when={detail()?.node.ended != null}>
          <div>
            <dt>{_(E.end)}</dt>
            <dd>{formatTime(detail()?.node.ended)}</dd>
          </div>
        </Show>
        <div>
          <dt>{_(E.elapsed)}</dt>
          <dd>{elapsed() ?? _(E.unknown)}</dd>
        </div>
        <Show when={detail()?.node.purpose}>
          <div>
            <dt>{_(E.purpose)}</dt>
            <dd>{detail()?.node.purpose}</dd>
          </div>
        </Show>
        <Show when={detail()?.node.attribution === "unassigned"}>
          <div>
            <dt>{_(E.rounds)}</dt>
            <dd>{_(E.unassigned)}</dd>
          </div>
        </Show>
      </dl>
      <Show when={record().timing}>
        <EvidenceBlock label={_(E.timing)} text={JSON.stringify(record().timing, null, 2)} language="json" />
      </Show>
      <Show when={record().pricingEvidence}>
        <EvidenceBlock
          label={_(E.priceEvidence)}
          text={JSON.stringify(record().pricingEvidence, null, 2)}
          language="json"
        />
      </Show>
    </section>
  )
  return (
    <section class="execution-inspector" aria-label={_(E.inspect)}>
      <div class="execution-inspector-header">
        <button type="button" class="execution-back" onClick={props.onBack} aria-label={_(E.back)}>
          <Icon name={getSemanticIcon("navigation.back")} size="small" />
        </button>
        <div class="execution-inspector-title">
          <strong>
            {(detail()?.node.group?.callCount ?? 0) > 1
              ? detail()?.node.group?.purpose || _(E.unclassified)
              : detail()?.node.tool || detail()?.node.title || _(E.loading)}
          </strong>
          <small title={props.filtered ? _(E.filteredNode) : undefined}>
            {detail() && _(K[detail()!.node.kind])} ·{" "}
            <span data-state={detail()?.execution?.status ?? detail()?.node.status}>
              {detail() && _(E[detail()!.execution?.status ?? detail()!.node.status])}
            </span>
            <Show when={elapsed() != null}> · {elapsed()}</Show>
            <Show when={props.filtered}> · {_(E.outsideFilters)}</Show>
          </small>
        </div>
        <Show when={detail()?.node.kind === "subtask"}>
          <button
            type="button"
            class="execution-icon-button"
            aria-label={_(E.openSession)}
            onClick={() => void navigate(detail()!.node.sessionID)}
          >
            <Icon name={getSemanticIcon("action.open")} size="small" />
          </button>
        </Show>
      </div>
      <Show when={error()}>
        <div class="execution-feedback" role="alert">
          {_(E.error)}{" "}
          <button type="button" onClick={() => void load(!detail())}>
            {_(E.retry)}
          </button>
        </div>
      </Show>
      <Show when={!detail() && loading()}>
        <div class="execution-feedback">{_(E.loading)}</div>
      </Show>
      <Show when={detail()}>
        <Show when={detail()?.node.ancestors?.some((ancestor) => ancestor.kind === "subtask")}>
          <nav class="execution-breadcrumbs" aria-label={_(E.trajectory)}>
            <For each={detail()?.node.ancestors?.filter((ancestor) => ancestor.kind === "subtask")}>
              {(ancestor) => (
                <button type="button" title={ancestor.title} onClick={() => props.onSelect(ancestor.id)}>
                  {ancestor.title}
                </button>
              )}
            </For>
          </nav>
        </Show>
        <Show when={tabs().length > 1}>
          <nav class="execution-tabs" aria-label={_(E.view)}>
            <For each={tabs()}>
              {(item) => (
                <button type="button" aria-current={tab() === item ? "page" : undefined} onClick={() => setTab(item)}>
                  {_(item === "request" ? E.savedRequest : E[item])}
                </button>
              )}
            </For>
          </nav>
        </Show>
        <div class="execution-inspector-body">
          <Show when={tab() === "result"}>
            <Show when={failure()}>
              <EvidenceBlock label={_(E.errorDetails)} text={failure()} />
            </Show>
            <For each={results()}>
              {(field) =>
                reader(field, _(field === "observation" ? E.observation : field === "stream" ? E.output : E.toolOutput))
              }
            </For>
            <Show when={detail()?.node.source === "messages"}>
              <EvidenceBlock
                label={_(K[detail()!.node.kind])}
                text={
                  typeof object(record().part).text === "string"
                    ? (object(record().part).text as string)
                    : JSON.stringify(record(), null, 2)
                }
                language={typeof object(record().part).text === "string" ? "text" : "json"}
              />
            </Show>
            <Show when={!results().length && !failure() && detail()?.node.source !== "messages"}>
              <Show when={sources().includes("initialHistory")} fallback={timing()}>
                {reader("initialHistory", _(E.context))}
              </Show>
            </Show>
          </Show>
          <Show when={tab() === "diagnostics"}>
            <Show when={sources().includes("input")}>{reader("input", _(E.toolInput))}</Show>
            <Show
              when={
                detail()?.definitions != null &&
                (!Array.isArray(detail()?.definitions) || (detail()!.definitions as unknown[]).length)
              }
            >
              <EvidenceBlock
                label={_(E.definitions)}
                text={JSON.stringify(detail()?.definitions, null, 2)}
                language="json"
              />
              <p class="execution-help">{_(E.recordedDefinition)}</p>
            </Show>
            {timing()}
          </Show>
          <Show when={tab() === "request" || tab() === "response"}>
            <Show when={tab() === "request" && physical().length > 1}>
              <div class="execution-attempts">
                <For each={physical()}>
                  {(attempt) => (
                    <button type="button" data-state={attempt.status} onClick={() => props.onSelect(attempt.id)}>
                      {(attempt.attemptIndex ?? 0) === 0
                        ? _(E.firstRequest)
                        : _({ ...E.retryAttempt, values: { number: attempt.attemptIndex } })}
                      <span>{_(E[attempt.status])}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={tab()} keyed>
              {(field) =>
                reader(
                  field,
                  _(
                    field === "request"
                      ? detail()?.node.evidenceKind === "attempt"
                        ? E.actualRequest
                        : E.savedRequest
                      : E.response,
                  ),
                )
              }
            </Show>
            <Show when={tab() === "request"}>
              <details class="execution-timing-disclosure">
                <summary>{_(E.timing)}</summary>
                {timing()}
              </details>
            </Show>
          </Show>
          <Show when={tab() === "calls"}>
            <div class="execution-related">
              <For each={calls()}>
                {(call) => (
                  <button
                    type="button"
                    onClick={() =>
                      call.id === props.nodeID
                        ? setTab(sources().includes("request") ? "request" : "result")
                        : props.onSelect(call.id)
                    }
                  >
                    <span>{formatTime(call.started)}</span>
                    <strong>{call.modelID || call.title}</strong>
                    <span data-state={call.status}>{_(E[call.status])}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={calls().length < (detail()?.node.group?.callCount ?? 0)}>
              <p class="execution-help">
                {_({ ...E.callsTruncated, values: { shown: calls().length, total: detail()?.node.group!.callCount } })}
              </p>
            </Show>
          </Show>
          <Show when={detail()?.node.kind === "subtask" || (detail()?.node.group && !isModel())}>
            <div class="execution-related">
              <For
                each={detail()?.related.filter(
                  (node) =>
                    node.id === detail()?.node.group?.id ||
                    (detail()?.node.kind === "subtask" && node.kind !== "input"),
                )}
              >
                {(node) => (
                  <button type="button" onClick={() => props.onSelect(node.id)}>
                    <span>{_(K[node.kind])}</span>
                    <strong>{node.title}</strong>
                    <span data-state={node.status}>{_(E[node.status])}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  )
}
