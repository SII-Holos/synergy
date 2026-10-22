import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionContextSnapshot, ExecutionNodeDetail } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSDK } from "@/context/sdk"
import { useViewActivity } from "@/context/view-residency"
import { useNavigateToSession } from "@/composables/use-navigate-to-session"
import { E, K } from "./i18n"
import { D } from "./context-categories"
import { createExecutionClock } from "@/composables/create-execution-clock"
import { EvidenceReader } from "./reader"
import { EvidenceBlock } from "./block"

type Tab = "result" | "diagnostics"
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
  snapshot?: ExecutionContextSnapshot
}) {
  const { _, i18n } = useLingui()
  const sdk = useSDK()
  const viewActive = useViewActivity()
  const navigate = useNavigateToSession()
  const [detail, setDetail] = createSignal<ExecutionNodeDetail>()
  const [fresh, setFresh] = createSignal(false)
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden")
  const active = () => viewActive() && visible()
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
  let body: HTMLDivElement | undefined
  const offsets = new Map<Tab, number>()
  const chooseTab = (next: Tab) => {
    if (body) offsets.set(tab(), body.scrollTop)
    setTab(next)
    requestAnimationFrame(() => {
      if (body) body.scrollTop = offsets.get(next) ?? 0
    })
  }
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
  // A message node records its own text as the node title, so that title repeats the body instead of naming the
  // record. Such a node is identified by its kind; the text itself is read below as evidence.
  const namedByKind = () => detail()?.node.source === "messages"
  const heading = () => {
    const value = detail()
    if (!value) return _(E.loading)
    if (namedByKind()) return _(K[value.node.kind])
    if ((value.node.group?.callCount ?? 0) > 1) return value.node.group?.purpose || _(E.unclassified)
    return value.node.tool || value.node.title || _(K[value.node.kind])
  }
  const tabs = createMemo<Tab[]>(() => {
    const value = detail()
    if (!value || value.node.source === "messages") return []
    if (isModel()) return []
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
    if (!active() || !sdk.connected()) return
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
      if (disposed || version !== generation || controller.signal.aborted) return
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
        offsets.clear()
        if (body) body.scrollTop = 0
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
        if (connected) void load(!detail())
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      active,
      (enabled) => {
        if (enabled) {
          void load(!detail())
          return
        }
        generation++
        abort?.abort()
        clearTimeout(timer)
        setFresh(false)
        setLoading(false)
      },
      { defer: true },
    ),
  )
  const visibility = () => {
    setVisible(document.visibilityState !== "hidden")
    setFresh(false)
  }
  document.addEventListener("visibilitychange", visibility)
  createEffect(
    on(
      () => props.revision,
      () => {
        clearTimeout(timer)
        if (active() && detail()) timer = setTimeout(() => void load(), 500)
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
  const Reader = (field: { name: string; label: string }) => (
    <EvidenceReader
      sessionID={props.sessionID}
      nodeID={props.nodeID}
      field={field.name}
      label={field.label}
      runID={props.runID}
      revision={detail()?.sources.find((source) => source.field === field.name)?.artifact.bytes ?? 0}
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
        <Show when={!isModel()}>
          <div>
            <dt>{_(E.elapsed)}</dt>
            <dd>{elapsed() ?? _(E.unknown)}</dd>
          </div>
        </Show>
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
            <Show when={props.snapshot?.nodeID === props.nodeID}>
              {_({ ...D.request, values: { number: props.snapshot?.requestNumber ?? 0 } })} ·{" "}
            </Show>
            {heading()}
          </strong>
          <small title={props.filtered ? _(E.filteredNode) : undefined}>
            <Show when={detail() && !namedByKind()}>{_(K[detail()!.node.kind])} · </Show>
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
                <button
                  type="button"
                  aria-current={tab() === item ? "page" : undefined}
                  onClick={() => chooseTab(item)}
                >
                  {_(E[item])}
                </button>
              )}
            </For>
          </nav>
        </Show>
        <div class="execution-inspector-body" ref={body}>
          <Show when={isModel()}>
            <section class="execution-request-summary">
              <p class="execution-request-description">
                {_(detail()?.node.usageRole === "auxiliary" ? E.auxiliaryRequest : E.conversationRequest)}
              </p>
              <dl class="execution-request-metrics">
                <Show
                  when={props.snapshot?.nodeID === props.nodeID}
                  fallback={
                    <div>
                      <dt>{_(E.tokens)}</dt>
                      <dd>
                        {detail()?.node.tokens?.total == null
                          ? "—"
                          : new Intl.NumberFormat(i18n().locale).format(detail()!.node.tokens!.total!)}
                      </dd>
                    </div>
                  }
                >
                  <div>
                    <dt>{_(E.input)}</dt>
                    <dd>
                      {props.snapshot?.inputTokens == null
                        ? "—"
                        : new Intl.NumberFormat(i18n().locale).format(props.snapshot.inputTokens)}
                    </dd>
                  </div>
                  <div>
                    <dt>{_(E.output)}</dt>
                    <dd>
                      {props.snapshot?.outputTokens == null
                        ? "—"
                        : new Intl.NumberFormat(i18n().locale).format(props.snapshot.outputTokens)}
                    </dd>
                  </div>
                </Show>
                <div>
                  <dt>{_(E.elapsed)}</dt>
                  <dd>{elapsed() ?? "—"}</dd>
                </div>
                <div>
                  <dt>{_(E.retryCount)}</dt>
                  <dd>
                    {props.snapshot?.nodeID === props.nodeID
                      ? props.snapshot.retries
                      : (detail()?.node.group?.retryCount ?? Math.max(0, physical().length - 1))}
                  </dd>
                </div>
              </dl>
              <dl class="execution-detail-rows">
                <div>
                  <dt>{_(E.model)}</dt>
                  <dd>{detail()?.node.modelID || detail()?.node.title}</dd>
                </div>
                <Show when={typeof object(record().model).providerID === "string"}>
                  <div>
                    <dt>{_(E.provider)}</dt>
                    <dd>{object(record().model).providerID as string}</dd>
                  </div>
                </Show>
              </dl>
              <Show when={failure()}>
                <EvidenceBlock label={_(E.errorDetails)} text={failure()} />
              </Show>
            </section>
            <Show when={sources().includes("request")}>
              <Reader
                name="request"
                label={_(detail()?.node.evidenceKind === "attempt" ? E.actualRequest : E.savedRequest)}
              />
            </Show>
            <Show when={sources().includes("response")}>
              <Reader name="response" label={_(E.response)} />
            </Show>
            {timing()}
            <Show when={physical().length > 1 || (detail()?.node.group?.callCount ?? 0) > 1}>
              <section class="execution-request-related">
                <Show when={physical().length > 1}>
                  <h3>{_(K.retry)}</h3>
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
                <Show when={(detail()?.node.group?.callCount ?? 0) > 1}>
                  <h3>{_(E.calls)}</h3>
                  <div class="execution-related">
                    <For each={calls()}>
                      {(call) => (
                        <button
                          type="button"
                          disabled={call.id === props.nodeID}
                          onClick={() => props.onSelect(call.id)}
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
                      {_({
                        ...E.callsTruncated,
                        values: { shown: calls().length, total: detail()?.node.group!.callCount },
                      })}
                    </p>
                  </Show>
                </Show>
              </section>
            </Show>
          </Show>
          <Show when={!isModel() && tab() === "result"}>
            <Show when={failure()}>
              <EvidenceBlock label={_(E.errorDetails)} text={failure()} />
            </Show>
            <For each={results()}>
              {(field) => (
                <Reader
                  name={field}
                  label={_(field === "observation" ? E.observation : field === "stream" ? E.output : E.toolOutput)}
                />
              )}
            </For>
            <Show when={detail()?.node.source === "messages"}>
              <Reader name="message" label={_(E.message)} />
            </Show>
            <Show when={!results().length && !failure() && detail()?.node.source !== "messages"}>
              <Show when={sources().includes("initialHistory")} fallback={timing()}>
                <Reader name="initialHistory" label={_(E.context)} />
              </Show>
            </Show>
          </Show>
          <Show when={!isModel() && tab() === "diagnostics"}>
            <Show when={sources().includes("input")}>
              <Reader name="input" label={_(E.toolInput)} />
            </Show>
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
