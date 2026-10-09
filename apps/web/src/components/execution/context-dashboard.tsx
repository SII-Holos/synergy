import { batch, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { useParams } from "@solidjs/router"
import type { ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { useExecution } from "@/context/execution"
import { useSDK } from "@/context/sdk"
import { useWorkbenchPanels } from "@/context/workbench"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { createExecutionClock } from "@/composables/create-execution-clock"
import { ExecutionPanelBody } from "./panel"
import { D } from "./context-categories"
import { contextDashboardState } from "./context-dashboard-state"
import { ContextHistoryChart } from "./context-chart"
import { ContextComposition } from "./context-composition"
import { ContextDashboardLayout } from "./context-dashboard-layout"
import { ContextUsageStats } from "./context-usage-stats"
import { ContextActivity, type ExecutionRecordsTarget } from "./context-activity"
import { ContextTiming } from "./context-timing"
import { ContextBrowser } from "./context-browser"
import { E } from "./i18n"
import "./context-dashboard.css"

const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})

export function ContextWorkbenchContent(props: WorkbenchPanelContentProps) {
  const execution = useExecution()
  const sdk = useSDK()
  const panels = useWorkbenchPanels()
  const params = useParams()
  const { _, i18n } = useLingui()
  const tabID = props.tab.id
  let tabState = record(props.tab.state)
  createEffect(() => {
    tabState = record(props.tab.state)
  })
  const initial = contextDashboardState(props.tab.state)
  const [runID, setRunID] = createSignal(initial.runID)
  const [selected, setSelected] = createSignal(initial.selected)
  const [category, setCategory] = createSignal(initial.category)
  const [highlight, setHighlight] = createSignal("")
  const [previewRequest, setPreviewRequest] = createSignal("")
  const [grouping, setGrouping] = createSignal(initial.grouping)
  const [delta, setDelta] = createSignal(initial.delta)
  const [records, setRecords] = createSignal(initial.records)
  const [diagnosticTab, setDiagnosticTab] = createSignal<WorkbenchPanelContentProps["tab"]>({
    ...props.tab,
    state: { ...tabState, runID: initial.records ? tabState.runID : runID() || undefined },
  })
  const [scoped, setScoped] = createStore<{ summary?: ExecutionSummary; error: boolean }>({ error: false })
  let scroll = initial.scroll
  let scroller: HTMLDivElement | undefined
  let returnButton: HTMLElement | undefined
  let summaryAbort: AbortController | undefined
  let summaryRequest = 0
  let summaryOwner = ""
  const visible = () =>
    execution.available() &&
    (["side", "bottom"] as const).some(
      (surface) => panels.surface(surface).opened() && panels.surface(surface).active() === tabID,
    )
  const active = () => visible() && !records()
  const history = execution.createContextHistory({ runID, selected, active: visible })
  createEffect(
    on(active, (visible) => {
      if (visible && !execution.state.summary && !execution.state.loading) void execution.refresh()
    }),
  )
  const snapshot = history.snapshot
  const displayed = () => history.state.items.find((entry) => entry.callID === previewRequest()) ?? snapshot()
  const summary = () => (runID() ? scoped.summary : execution.state.summary)
  const now = createExecutionClock(summary, execution.connected)
  const savedDashboard = () => ({
    runID: runID(),
    selected: selected(),
    category: category(),
    grouping: grouping(),
    delta: delta(),
    scroll,
    records: records(),
  })
  const remember = () => panels.updateTab(tabID, { state: { ...tabState, contextDashboard: savedDashboard() } })
  const rememberRecords = (state: Record<string, unknown>) => {
    setDiagnosticTab((tab) => ({ ...tab, state: { ...record(tab.state), ...state } }))
    panels.updateTab(tabID, { state: { ...tabState, ...state, contextDashboard: savedDashboard() } })
  }
  createEffect(on([runID, selected, category, grouping, delta, records], remember))
  createEffect(
    on([runID, active, execution.connectionVersion, () => params.id], async () => {
      summaryAbort?.abort()
      const request = ++summaryRequest
      const sessionID = params.id
      const owner = JSON.stringify([sdk.url, sdk.scopeID, sessionID, runID()])
      if (owner !== summaryOwner) {
        summaryOwner = owner
        setScoped({ summary: undefined, error: false })
      } else setScoped("error", false)
      if (!runID() || !active() || !sessionID) return
      const controller = new AbortController()
      summaryAbort = controller
      try {
        const response = await sdk.client.session.executionSummary(
          { sessionID, runID: runID() },
          { signal: controller.signal, throwOnError: true },
        )
        if (request !== summaryRequest || controller.signal.aborted) return
        if (!scoped.summary || response.data.revision >= scoped.summary.revision)
          setScoped("summary", reconcile(response.data))
      } catch {
        if (!controller.signal.aborted && request === summaryRequest) setScoped("error", true)
      }
    }),
  )
  const unsubscribe = sdk.event.on("execution.updated", (event) => {
    if (event.properties.sessionID !== params.id || !runID()) return
    const next = event.properties.roundSummaries.find((entry) => entry.runID === runID())
    if (next && (!scoped.summary || next.revision >= scoped.summary.revision)) setScoped("summary", reconcile(next))
  })
  onCleanup(() => {
    summaryRequest++
    summaryAbort?.abort()
    unsubscribe()
    remember()
  })
  const select = (id: string) => setSelected(id)
  const selectRound = (value: string) =>
    batch(() => {
      setRunID(value)
      setPreviewRequest("")
      setSelected("")
      setCategory("")
      scroll = 0
      scroller?.scrollTo({ top: 0 })
    })
  const openRecords = (target: ExecutionRecordsTarget = {}) => {
    returnButton = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    scroll = scroller?.scrollTop ?? scroll
    setDiagnosticTab({
      ...props.tab,
      state: {
        ...tabState,
        runID: target.runID ?? runID(),
        nodeID: target.nodeID,
        kinds: target.kinds ?? [],
        statuses: target.statuses ?? [],
        anomalies: target.anomalies ?? false,
        query: "",
        actor: target.actor ?? "",
        mode: target.nodeID || target.kinds?.includes("retry") ? "records" : "process",
      },
    })
    setRecords(true)
  }
  const diagnosticRun = () => record(diagnosticTab().state).runID as string | undefined
  const scopeLabel = () => {
    if (!diagnosticRun()) return _(D.taskScope)
    const index = execution.state.summary?.rounds.findIndex((round) => round.id === diagnosticRun()) ?? -1
    return index < 0 ? _(E.unassigned) : _({ ...E.round, values: { number: index + 1 } })
  }
  const back = () => {
    setRecords(false)
    requestAnimationFrame(() => {
      const target = returnButton?.isConnected
        ? returnButton
        : scroller?.querySelector<HTMLButtonElement>(".context-dashboard-toolbar button")
      target?.focus({ preventScroll: true })
    })
  }
  return (
    <div class="context-dashboard-shell">
      <Show when={records()}>
        <div class="context-diagnostics">
          <ExecutionPanelBody
            {...props}
            tab={diagnosticTab()}
            runID={diagnosticRun() ?? ""}
            scopeLabel={scopeLabel()}
            onBack={back}
            onStateChange={rememberRecords}
            snapshot={(nodeID) =>
              history.state.items.find((entry) => entry.nodeID === nodeID) ??
              (snapshot()?.nodeID === nodeID ? snapshot() : undefined)
            }
          />
        </div>
      </Show>
      <div
        class="context-dashboard"
        hidden={records()}
        ref={(element) => {
          scroller = element
          requestAnimationFrame(() => (element.scrollTop = scroll))
        }}
        onScroll={(event) => {
          scroll = event.currentTarget.scrollTop
        }}
      >
        <div class="context-dashboard-toolbar">
          <MenuField
            value={runID()}
            ariaLabel={_(E.rounds)}
            options={[
              { value: "", label: _(D.taskScope) },
              ...(execution.state.summary?.rounds.map((round, index) => ({
                value: round.id,
                label: _({ ...E.round, values: { number: index + 1 } }),
              })) ?? []),
            ]}
            onChange={selectRound}
          />
          <span class="context-toolbar-summary">
            {_({ ...D.mainRequests, values: { count: history.state.total } })}
            <Show when={summary()}>
              {(value) => (
                <>
                  {" "}
                  ·{" "}
                  {_({
                    ...D.toolCount,
                    values: { count: value().tools.reduce((total, tool) => total + tool.calls, 0) },
                  })}
                </>
              )}
            </Show>
          </span>
        </div>
        <ContextDashboardLayout
          composition={
            <ContextComposition
              snapshot={history.state.latest}
              category={category()}
              highlight={highlight()}
              onHighlight={setHighlight}
              onCategory={(value) => {
                setCategory(value)
                if (value)
                  requestAnimationFrame(() => {
                    const heading = scroller?.querySelector<HTMLButtonElement>(`[data-context-category="${value}"]`)
                    heading?.focus({ preventScroll: true })
                    heading?.scrollIntoView({
                      block: "nearest",
                      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
                    })
                  })
              }}
            />
          }
          metrics={<Show when={summary()}>{(value) => <ContextUsageStats summary={value()} now={now()} />}</Show>}
          history={
            <>
              <Show when={history.state.error || scoped.error || execution.state.error}>
                <p class="context-note" role="alert">
                  {_(D.error)}{" "}
                  <button
                    class="context-link"
                    onClick={() => {
                      void history.load()
                      void execution.refresh()
                    }}
                  >
                    {_(E.retry)}
                  </button>
                </p>
              </Show>
              <Show when={history.state.loading && !history.state.items.length}>
                <p class="context-note" role="status">
                  {_(D.loading)}
                </p>
              </Show>
              <ContextHistoryChart
                onPreview={setPreviewRequest}
                items={history.state.items}
                selected={snapshot()?.callID ?? ""}
                selectedSnapshot={snapshot()}
                rounds={summary()?.rounds}
                onSelect={select}
                onInspect={(entry) => openRecords({ nodeID: entry.nodeID })}
                grouping={grouping()}
                onGrouping={setGrouping}
                delta={delta()}
                onDelta={setDelta}
              />
              <Show when={history.state.nextCursor}>
                <button
                  type="button"
                  class="context-link context-load-history"
                  disabled={history.state.loading}
                  onClick={() => void history.load(true)}
                >
                  {_(D.earlier)}
                </button>
              </Show>
            </>
          }
          timing={<Show when={summary()}>{(value) => <ContextTiming summary={value()} />}</Show>}
          contents={
            <ContextBrowser
              snapshot={displayed()}
              selected={selected()}
              previewing={!!previewRequest()}
              onSelect={setSelected}
              history={history.state.items}
              category={category()}
              highlight={highlight()}
              onHighlight={setHighlight}
              onCategory={setCategory}
              active={active()}
            />
          }
          activity={
            <Show when={summary()}>{(value) => <ContextActivity summary={value()} onRecords={openRecords} />}</Show>
          }
          events={
            <section class="context-events" aria-label={_(D.events)}>
              <div class="context-section-heading">
                <h3>{_(D.events)}</h3>
              </div>
              <Show
                when={history.state.items.some((entry) => entry.compactedBefore)}
                fallback={<p class="context-note">{_(D.noEvents)}</p>}
              >
                <For each={history.state.items.filter((entry) => entry.compactedBefore)}>
                  {(entry) => (
                    <button class="context-event" onClick={() => select(entry.callID)}>
                      <span aria-hidden="true">◇</span>
                      <span>{_(D.compaction)}</span>
                      <time>
                        {new Intl.DateTimeFormat(i18n().locale, { hour: "2-digit", minute: "2-digit" }).format(
                          entry.started,
                        )}
                      </time>
                    </button>
                  )}
                </For>
              </Show>
            </section>
          }
        />
      </div>
    </div>
  )
}
