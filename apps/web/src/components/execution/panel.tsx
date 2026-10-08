import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import { createExecutionClock } from "@/composables/create-execution-clock"
import { batch, createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js"
import { z } from "zod"
import { useLingui } from "@lingui/solid"
import { useParams } from "@solidjs/router"
import { VList, type VListHandle } from "virtua/solid"
import type { ExecutionTrajectoryNode } from "@ericsanchezok/synergy-sdk/client"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Checkbox } from "@ericsanchezok/synergy-ui/checkbox"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useExecution } from "@/context/execution"
import { useSDK } from "@/context/sdk"
import { useWorkbenchPanels } from "@/context/workbench"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { ExecutionOverview } from "./overview"
import { ExecutionInspector } from "./inspector"
import { createExecutionTrajectory } from "./trajectory"
import { mergeExecutionWindow } from "./window"
import { E, K } from "./i18n"
import "./execution.css"

const kinds = Object.keys(K) as (keyof typeof K)[]
const statuses = ["running", "completed", "failed", "cancelled", "interrupted", "unknown"] as const
const PanelState = z.object({
  runID: z.string().optional(),
  nodeID: z.string().optional(),
  actor: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  query: z.string().optional(),
  kinds: z.array(z.string()).optional(),
  statuses: z.array(z.string()).optional(),
  anomalies: z.boolean().optional(),
  mode: z.enum(["process", "records"]).optional(),
  view: z.enum(["time", "rounds", "calls"]).optional(),
  expanded: z.array(z.string()).optional(),
  scroll: z.number().optional(),
  focus: z.string().optional(),
  readingNode: z.string().optional(),
  readingOffset: z.number().optional(),
})
const settings = (value: unknown) => PanelState.safeParse(value).data ?? {}
type Branch = {
  node: ExecutionTrajectoryNode
  rows: ExecutionTrajectoryNode[]
  next: boolean
  loading: boolean
  error: boolean
  pending: number
}
type Line = { node: ExecutionTrajectoryNode; depth: number; branch?: string }
const glyphs: Record<ExecutionTrajectoryNode["kind"], SemanticIconTokenName> = {
  turn: "session.taskDetails",
  input: "session.default",
  context: "session.taskDetails",
  reasoning: "performance.trace",
  output: "session.default",
  model: "settings.models",
  retry: "session.retry",
  tool: "performance.tools",
  process: "terminal.main",
  compaction: "session.context",
  subtask: "agents.main",
}

function ExecutionPanelBody(
  props: WorkbenchPanelContentProps & { expanded?: boolean; active?: () => boolean; onExpand?: () => void },
) {
  const params = useParams()
  const sdk = useSDK()
  const execution = useExecution()
  const panels = useWorkbenchPanels()
  const { _, i18n } = useLingui()
  const initial = settings(props.tab.state)
  const [runID, setRunID] = createSignal(initial.runID ?? "")
  const [actor, setActor] = createSignal(initial.actor ?? "")
  const [types, setTypes] = createSignal(initial.kinds ?? (initial.kind ? [initial.kind] : []))
  const [states, setStates] = createSignal(initial.statuses ?? (initial.status ? [initial.status] : []))
  const [anomalies, setAnomalies] = createSignal(initial.anomalies ?? false)
  const [query, setQuery] = createSignal(initial.query ?? "")
  const [search, setSearch] = createSignal(query())
  const [mode, setMode] = createSignal(initial.mode ?? "process")
  const [view, setView] = createSignal(initial.view ?? "time")
  const [selected, setSelected] = createSignal(initial.nodeID ?? "")
  const [trail, setTrail] = createSignal<string[]>([])
  const [anchor, setAnchor] = createSignal(initial.nodeID ?? "")
  const [expandedTasks, setExpandedTasks] = createSignal(new Set(initial.expanded ?? []))
  const [branches, setBranches] = createSignal(new Map<string, Branch>())
  const [exporting, setExporting] = createSignal(false)
  const [exportError, setExportError] = createSignal(false)
  const [filtersOpen, setFiltersOpen] = createSignal(false)
  const actorGroup = createUniqueId()
  let list: VListHandle | undefined
  let root: HTMLDivElement | undefined
  let historyOffset = initial.scroll ?? 0
  let focusID = initial.focus ?? ""
  let reading = initial.readingNode ? { id: initial.readingNode, relative: initial.readingOffset ?? 0 } : undefined
  let written = ""
  let frame: number | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  const branchAbort = new Map<string, AbortController>()
  const exportAbort = new AbortController()
  const active = () => props.active?.() !== false
  const branchCount = createMemo(() => [...branches().values()].reduce((sum, branch) => sum + branch.rows.length, 0))
  const trajectory = createExecutionTrajectory({
    sdk,
    sessionID: () => params.id,
    runID,
    actor,
    kind: () => "",
    status: () => "",
    query,
    anchor,
    connectionVersion: execution.connectionVersion,
    enabled: active,
    mode,
    kinds: () => types().join(","),
    statuses: () => states().join(","),
    anomalies,
    order: () => (view() === "rounds" ? "round" : view() === "calls" ? "call" : "time"),
    capacity: () => 500 - branchCount(),
    rounds: () => execution.state.summary?.rounds ?? [],
  })
  const summary = () => trajectory.state.summary ?? execution.state.summary
  const now = createExecutionClock(summary, execution.connected)
  const nodeExecution = (node: ExecutionTrajectoryNode) =>
    node.kind === "subtask"
      ? summary()?.tasks.find((task) => task.sessionID === node.sessionID)
      : node.kind === "turn" && node.sessionID === params.id
        ? summary()?.rounds.find((round) => round.id === node.runID)
        : undefined
  const nodeDuration = (node: ExecutionTrajectoryNode) => {
    const value = nodeExecution(node)
    if (value)
      return value.elapsedMs == null
        ? undefined
        : executionDuration(value.elapsedMs + (value.elapsedActive ? now() : 0), value.elapsedLowerBound)
    if (node.kind === "turn" || node.kind === "subtask") return undefined
    return node.ended === undefined ? time(node.started) : executionDuration(node.ended - node.started)
  }
  const remember = () => {
    const state = {
      runID: runID() || undefined,
      actor: actor(),
      kinds: types(),
      statuses: states(),
      anomalies: anomalies(),
      query: query(),
      mode: mode(),
      view: view(),
      nodeID: selected() || undefined,
      expanded: [...expandedTasks()],
      scroll: historyOffset,
      focus: focusID,
      readingNode: reading?.id,
      readingOffset: reading?.relative,
    }
    written = JSON.stringify(state)
    panels.updateTab(props.tab.id, { state })
  }
  createEffect(on([runID, actor, types, states, anomalies, query, mode, view, selected, expandedTasks], remember))
  createEffect(
    on(
      () => props.tab.state,
      (value) => {
        if (JSON.stringify(value) === written) return
        const next = settings(value)
        batch(() => {
          setRunID(next.runID ?? "")
          setActor(next.actor ?? "")
          setTypes(next.kinds ?? (next.kind ? [next.kind] : []))
          setStates(next.statuses ?? (next.status ? [next.status] : []))
          setAnomalies(next.anomalies ?? false)
          setSearch(next.query ?? "")
          setMode(next.mode ?? "process")
          setView(next.view ?? "time")
          if ((next.nodeID ?? "") !== selected()) {
            setSelected(next.nodeID ?? "")
            setAnchor(next.nodeID ?? "")
            setTrail([])
          }
        })
      },
    ),
  )
  createEffect(
    on(search, (value) => {
      clearTimeout(debounce)
      debounce = setTimeout(() => setQuery(value), 250)
    }),
  )
  const updateBranch = (id: string, value: Branch) =>
    setBranches((current) => {
      const next = new Map(current)
      next.delete(id)
      next.set(id, value)
      let count = [...next.values()].reduce((sum, branch) => sum + branch.rows.length, 0)
      for (const [key, branch] of next) {
        if (count <= 400) break
        const removed = Math.min(count - 400, Math.max(0, branch.rows.length - 1))
        if (!removed) continue
        next.set(key, { ...branch, rows: branch.rows.slice(0, branch.rows.length - removed), next: true })
        count -= removed
      }
      return next
    })
  const loadBranch = async (node: ExecutionTrajectoryNode, later = false, latest = false, recover = false) => {
    branchAbort.get(node.id)?.abort()
    const controller = new AbortController()
    branchAbort.set(node.id, controller)
    const old = branches().get(node.id)
    updateBranch(node.id, {
      node,
      rows: old?.rows ?? [],
      next: old?.next ?? false,
      loading: true,
      error: false,
      pending: latest ? 0 : (old?.pending ?? 0),
    })
    try {
      const response = await sdk.client.session.executionTrajectory(
        {
          sessionID: node.sessionID,
          runID: node.runID,
          actor: "main",
          mode: mode(),
          anchor: latest
            ? "latest"
            : later
              ? old?.rows.at(-1)?.id
              : recover
                ? old?.rows[Math.floor(old.rows.length / 2)]?.id
                : undefined,
          position: later ? "after" : recover && old?.rows.length ? "around" : undefined,
          limit: recover ? Math.min(200, Math.max(100, old?.rows.length ?? 0)) : 100,
        },
        { signal: controller.signal, throwOnError: true },
      )
      if (controller.signal.aborted || !expandedTasks().has(node.id) || !active()) return
      const items = response.data.items.filter((row) => row.id !== node.id)
      const current = branches().get(node.id)
      const rows = later
        ? [...new Map([...(current?.rows ?? []), ...items].map((row) => [row.id, row])).values()].slice(-200)
        : items
      updateBranch(node.id, {
        node,
        rows,
        next: !!response.data.nextCursor,
        loading: false,
        error: false,
        pending: latest ? 0 : (current?.pending ?? 0),
      })
    } catch {
      if (!controller.signal.aborted && expandedTasks().has(node.id))
        updateBranch(node.id, { ...branches().get(node.id)!, loading: false, error: true })
    }
  }
  const toggleTask = (node: ExecutionTrajectoryNode) => {
    const next = new Set(expandedTasks())
    if (next.has(node.id)) {
      next.delete(node.id)
      branchAbort.get(node.id)?.abort()
      setBranches((old) => {
        const value = new Map(old)
        value.delete(node.id)
        return value
      })
    } else {
      next.add(node.id)
      trajectory.setHistory(true)
    }
    setExpandedTasks(next)
    if (next.has(node.id)) void loadBranch(node)
  }
  const rows = createMemo(() => {
    const result: Line[] = []
    const seen = new Set<string>()
    const add = (node: ExecutionTrajectoryNode, depth: number) => {
      if (seen.has(node.id)) return
      seen.add(node.id)
      result.push({ node, depth })
      if (!expandedTasks().has(node.id)) return
      const branch = branches().get(node.id)
      for (const child of branch?.rows ?? []) add(child, depth + 1)
      if (branch && (branch.next || branch.loading || branch.error))
        result.push({ node, depth: depth + 1, branch: node.id })
    }
    for (const node of trajectory.state.rows) add(node, 0)
    return result
  })
  const unsubscribe = sdk.event.on("execution.updated", (event) => {
    if (!active() || event.properties.sessionID !== params.id) return
    const update = event.properties
    for (const [id, branch] of branches()) {
      const updates = (mode() === "process" ? (update.processUpserts ?? update.upserts) : update.upserts).filter(
        (node) => node.sessionID === branch.node.sessionID && node.runID === branch.node.runID && node.id !== id,
      )
      const removed = mode() === "process" ? [...update.removed, ...(update.processRemoved ?? [])] : update.removed
      const changed = mergeExecutionWindow(branch.rows, updates, removed, {
        history: trajectory.state.history,
        cap: 200,
      })
      updateBranch(id, {
        ...branch,
        rows: changed.rows,
        pending: branch.pending + (trajectory.state.history ? changed.added : 0),
      })
    }
  })
  const select = (id: string, nested = false) => {
    if (!selected()) {
      historyOffset = list?.scrollOffset ?? historyOffset
      focusID = id
    }
    setTrail(nested && selected() ? [...trail(), selected()] : [])
    setSelected(id)
    trajectory.setHistory(true)
    frame = requestAnimationFrame(() => {
      if (root && getComputedStyle(root.querySelector(".execution-trajectory-pane")!).display === "none")
        root.querySelector<HTMLButtonElement>(".execution-back")?.focus()
    })
  }
  const scrollTo = (offset: number) => {
    const viewport = root?.querySelector<HTMLElement>(".execution-list")
    if (viewport) viewport.scrollTop = offset
  }
  const scrollToIndex = (index: number, align: "start" | "end" | "nearest") => {
    if (!list || index < 0 || index >= rows().length) return
    const offset = list.getItemOffset(index)
    const end = offset + list.getItemSize(index)
    if (align === "nearest" && offset >= list.scrollOffset && end <= list.scrollOffset + list.viewportSize) return
    scrollTo(
      align === "end" || (align === "nearest" && end > list.scrollOffset + list.viewportSize)
        ? end - list.viewportSize
        : offset,
    )
  }
  const restoreReading = () => {
    const index = reading ? rows().findIndex((row) => row.node.id === reading!.id) : -1
    if (index >= 0 && list) {
      scrollTo(list.getItemOffset(index) + reading!.relative)
    } else scrollTo(historyOffset)
  }
  const back = () => {
    if (trail().length) {
      setSelected(trail().at(-1)!)
      setTrail(trail().slice(0, -1))
      return
    }
    setSelected("")
    frame = requestAnimationFrame(() => {
      restoreReading()
      requestAnimationFrame(() => {
        const button = root?.querySelector<HTMLButtonElement>(
          '[data-node-id="' + CSS.escape(focusID) + '"] .execution-node-button',
        )
        if (button) button.focus()
        else root?.querySelector<HTMLElement>(".execution-list")?.focus()
      })
    })
  }
  const locate = (id: string) => select(id)
  const pending = () =>
    trajectory.state.pending + [...branches().values()].reduce((sum, branch) => sum + branch.pending, 0)
  const latest = async () => {
    setSelected("")
    setTrail([])
    setAnchor("")
    await Promise.all([
      trajectory.load(undefined, "latest"),
      ...[...branches().values()].map((branch) => loadBranch(branch.node, false, true)),
    ])
    trajectory.setHistory(false)
    frame = requestAnimationFrame(() => scrollToIndex(rows().length - 1, "end"))
  }
  createEffect(
    on(
      () => trajectory.state.revision,
      () => {
        if (selected()) return
        if (!trajectory.state.history && rows().length)
          frame = requestAnimationFrame(() => {
            if (!trajectory.state.history && !selected()) scrollToIndex(rows().length - 1, "end")
          })
        for (const node of trajectory.state.rows)
          if (expandedTasks().has(node.id) && !branches().has(node.id) && active()) void loadBranch(node)
      },
    ),
  )
  createEffect(
    on(
      rows,
      () => {
        if (!selected() && trajectory.state.history && reading) frame = requestAnimationFrame(restoreReading)
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      [active, execution.connectionVersion, mode],
      (value, previous) => {
        for (const controller of branchAbort.values()) controller.abort()
        if (active())
          for (const branch of branches().values())
            void loadBranch(branch.node, false, false, value[2] === previous?.[2] && trajectory.state.history)
      },
      { defer: true },
    ),
  )
  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
  const filterCount = () => types().length + states().length + Number(anomalies()) + Number(!!actor())
  const clear = () =>
    batch(() => {
      setActor("")
      setTypes([])
      setStates([])
      setAnomalies(false)
    })
  const exportTrajectory = async () => {
    if (!params.id || exporting()) return
    setExporting(true)
    setExportError(false)
    const parts: BlobPart[] = [JSON.stringify({ summary: summary() }).slice(0, -1) + ',"nodes":[']
    try {
      let cursor: string | undefined
      let first = true
      let revision: number | undefined
      do {
        const response = await sdk.client.session.executionTrajectory(
          { sessionID: params.id!, runID: runID() || undefined, actor: "all", mode: "records", cursor, limit: 500 },
          { signal: exportAbort.signal, throwOnError: true },
        )
        if (revision !== undefined && revision !== response.data.revision)
          throw new Error("Execution export snapshot changed")
        revision = response.data.revision
        const json = JSON.stringify(response.data.items).slice(1, -1)
        if (json) {
          parts.push((first ? "" : ",") + json)
          first = false
        }
        cursor = response.data.nextCursor ?? undefined
      } while (cursor)
      parts.push("]}")
      const url = URL.createObjectURL(new Blob(parts, { type: "application/json" }))
      const link = document.createElement("a")
      link.href = url
      link.download = "execution-trajectory.json"
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      if (!exportAbort.signal.aborted) setExportError(true)
    } finally {
      parts.length = 0
      setExporting(false)
    }
  }
  onCleanup(() => {
    clearTimeout(debounce)
    if (frame) cancelAnimationFrame(frame)
    exportAbort.abort()
    for (const abort of branchAbort.values()) abort.abort()
    unsubscribe()
  })
  const time = (value: number) =>
    new Intl.DateTimeFormat(i18n().locale, { hour: "2-digit", minute: "2-digit" }).format(value)
  const node = () => rows().find((row) => row.node.id === selected())?.node
  const title = (row: ExecutionTrajectoryNode) =>
    (row.group?.callCount ?? 0) > 1
      ? (row.group?.purpose || _(E.unclassified)) +
        " · " +
        _({ ...E.callCount, values: { count: row.group!.callCount } })
      : row.evidenceKind === "call" && !row.purpose
        ? _(E.unclassified) + " · " + row.title
        : row.kind === "retry"
          ? _({ ...E.retryAttempt, values: { number: row.attemptIndex ?? row.title } }) +
            (row.preview ? " · " + row.preview : "")
          : row.preview || row.title || _(K[row.kind])
  return (
    <div
      ref={root}
      class="execution-panel"
      classList={{ "execution-panel--expanded": props.expanded, "execution-panel--inspecting": !!selected() }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selected() && !event.defaultPrevented && !filtersOpen()) {
          event.preventDefault()
          event.stopPropagation()
          back()
        }
      }}
    >
      <div class="execution-global">
        <div class="execution-panel-toolbar">
          <div class="execution-round-selector">
            <MenuField
              ariaLabel={_(E.rounds)}
              value={runID()}
              options={[
                { value: "", label: _(E.allRounds) },
                ...(execution.state.summary?.rounds ?? []).map((round, index) => ({
                  value: round.id,
                  label:
                    _({ ...E.round, values: { number: index + 1 } }) +
                    " · " +
                    time(round.started) +
                    " · " +
                    _(E[round.status]),
                })),
              ]}
              onChange={(value) => {
                setSelected("")
                setTrail([])
                setAnchor("")
                setRunID(value)
              }}
            />
          </div>
          <button
            type="button"
            class="execution-icon-button"
            aria-label={_(E.export)}
            disabled={exporting()}
            onClick={() => void exportTrajectory()}
          >
            <Icon name={getSemanticIcon("action.export")} size="small" />
          </button>
          <Show when={props.onExpand}>
            <button type="button" class="execution-icon-button" aria-label={_(E.expand)} onClick={props.onExpand}>
              <Icon name={getSemanticIcon("action.zoomIn")} size="small" />
            </button>
          </Show>
        </div>
        <Show
          when={summary()}
          fallback={<div class="execution-feedback">{_(execution.state.error ? E.error : E.loading)}</div>}
        >
          {(value) => <ExecutionOverview summary={value()} now={now()} onLocate={locate} />}
        </Show>
        <Show when={exportError()}>
          <p class="execution-feedback" role="alert">
            {_(E.error)}
          </p>
        </Show>
        <div class="execution-filters">
          <div class="execution-search-row">
            <label class="execution-search">
              <Icon name={getSemanticIcon("action.search")} size="small" />
              <input
                value={search()}
                onInput={(event) => setSearch(event.currentTarget.value)}
                placeholder={_(E.search)}
                aria-label={_(E.search)}
              />
            </label>
            <Popover
              title={_(E.filter)}
              variant="menu"
              class="execution-filter-popover"
              placement="bottom-end"
              open={filtersOpen()}
              onOpenChange={setFiltersOpen}
              triggerAs={(trigger) => (
                <button
                  {...trigger}
                  type="button"
                  class="execution-icon-button"
                  aria-label={_(E.filter)}
                  aria-expanded={filtersOpen()}
                >
                  <Icon name={getSemanticIcon("settings.general")} size="small" />
                  <Show when={filterCount()}>
                    <span>{filterCount()}</span>
                  </Show>
                </button>
              )}
            >
              <div
                class="execution-filter-options"
                on:keydown={(event) => {
                  if (event.key !== "Escape") return
                  event.preventDefault()
                  event.stopPropagation()
                  setFiltersOpen(false)
                }}
                on:focusin={(event) => {
                  if (!(event.target instanceof HTMLElement)) return
                  const choice = event.target.closest<HTMLElement>(
                    '.execution-actor-choice, [data-component="checkbox"]',
                  )
                  const container = event.currentTarget.closest<HTMLElement>('[data-slot="popover-body"]')
                  if (!choice || !container) return
                  const row = choice.getBoundingClientRect()
                  const view = container.getBoundingClientRect()
                  if (row.top < view.top) container.scrollTop += row.top - view.top
                  else if (row.bottom > view.bottom) container.scrollTop += row.bottom - view.bottom
                }}
              >
                <fieldset class="execution-actor-options">
                  <legend>{_(E.actor)}</legend>
                  <For
                    each={[
                      { id: "", title: _(E.own) },
                      { id: "all", title: _(E.allTasks) },
                      ...(summary()?.tasks.map((task) => ({ id: task.sessionID, title: task.title })) ?? []),
                    ]}
                  >
                    {(task) => (
                      <label class="execution-actor-choice">
                        <input
                          type="radio"
                          name={actorGroup}
                          checked={actor() === task.id}
                          onChange={() => setActor(task.id)}
                        />
                        <span>{task.title}</span>
                      </label>
                    )}
                  </For>
                </fieldset>
                <fieldset>
                  <legend>{_(E.type)}</legend>
                  <For each={kinds}>
                    {(kind) => (
                      <div class="execution-filter-choice">
                        <Checkbox checked={types().includes(kind)} onChange={() => setTypes(toggle(types(), kind))}>
                          {_(K[kind])}
                        </Checkbox>
                      </div>
                    )}
                  </For>
                </fieldset>
                <fieldset>
                  <legend>{_(E.status)}</legend>
                  <For each={statuses}>
                    {(status) => (
                      <div class="execution-filter-choice">
                        <Checkbox
                          checked={states().includes(status)}
                          onChange={() => setStates(toggle(states(), status))}
                        >
                          {_(E[status])}
                        </Checkbox>
                      </div>
                    )}
                  </For>
                </fieldset>
                <button type="button" class="execution-inline-action" onClick={clear}>
                  {_(E.clear)}
                </button>
              </div>
            </Popover>
          </div>
          <div class="execution-view-row">
            <div class="execution-view-switch" role="group" aria-label={_(E.view)}>
              <button type="button" aria-pressed={mode() === "process"} onClick={() => setMode("process")}>
                {_(E.processView)}
              </button>
              <button type="button" aria-pressed={mode() === "records"} onClick={() => setMode("records")}>
                {_(E.recordsView)}
              </button>
            </div>
            <button
              type="button"
              class="execution-anomalies"
              aria-pressed={anomalies()}
              onClick={() => setAnomalies(!anomalies())}
            >
              {_(E.anomalies)}
            </button>
          </div>
          <Show when={filterCount()}>
            <div class="execution-filter-chips">
              <For each={types()}>
                {(kind) => (
                  <button type="button" onClick={() => setTypes(types().filter((item) => item !== kind))}>
                    {_(K[kind as keyof typeof K])} ×
                  </button>
                )}
              </For>
              <For each={states()}>
                {(status) => (
                  <button type="button" onClick={() => setStates(states().filter((item) => item !== status))}>
                    {_(E[status as (typeof statuses)[number]])} ×
                  </button>
                )}
              </For>
              <Show when={actor()}>
                <button type="button" onClick={() => setActor("")}>
                  {actor() === "all"
                    ? _(E.allTasks)
                    : summary()?.tasks.find((task) => task.sessionID === actor())?.title}{" "}
                  ×
                </button>
              </Show>
            </div>
          </Show>
          <Show when={mode() === "records"}>
            <div class="execution-view-row execution-record-controls">
              <div class="execution-view-switch" role="group" aria-label={_(E.view)}>
                <For each={["time", "rounds", "calls"] as const}>
                  {(value) => (
                    <button type="button" aria-pressed={view() === value} onClick={() => setView(value)}>
                      {_(E[value])}
                    </button>
                  )}
                </For>
              </div>
              <span>{_({ ...E.eventCount, values: { count: trajectory.state.total } })}</span>
            </div>
          </Show>
        </div>
      </div>
      <div class="execution-workspace">
        <div class="execution-trajectory-pane">
          <Show when={trajectory.state.error}>
            <div class="execution-feedback" role="alert">
              {_(E.error)}{" "}
              <button type="button" onClick={() => void trajectory.load(undefined, anchor() || "latest")}>
                {_(E.retry)}
              </button>
            </div>
          </Show>
          <Show when={!rows().length}>
            <div class="execution-feedback">{_(trajectory.state.loading ? E.loading : E.empty)}</div>
          </Show>
          <Show when={trajectory.state.previous}>
            <button
              type="button"
              class="execution-page-link"
              disabled={trajectory.state.loading}
              onClick={() => void trajectory.load(trajectory.state.previous!, undefined, "previous")}
            >
              {_(E.previous)}
            </button>
          </Show>
          <VList
            ref={(value) => (list = value)}
            data={rows()}
            itemSize={52}
            overscan={2}
            class="execution-list"
            style={{ height: "100%" }}
            tabIndex={0}
            aria-label={_(E.trajectory)}
            onWheel={(event) => {
              if (event.deltaY < 0) trajectory.setHistory(true)
            }}
            onScroll={(offset) => {
              if (list)
                trajectory.setHistory(!!trajectory.state.next || offset < list.scrollSize - list.viewportSize - 24)
              if (!selected()) {
                historyOffset = offset
                const index = list?.findStartIndex() ?? 0
                const item = rows()[index]
                if (item && list) reading = { id: item.node.id, relative: offset - list.getItemOffset(index) }
              }
            }}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
              event.preventDefault()
              trajectory.setHistory(true)
              const id = (document.activeElement as HTMLElement)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId
              const current = rows().findIndex((line) => line.node.id === id && !line.branch)
              const index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? rows().length - 1
                    : Math.max(0, Math.min(rows().length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))
              scrollToIndex(index, "nearest")
              requestAnimationFrame(() =>
                root
                  ?.querySelector<HTMLButtonElement>(
                    '[data-node-id="' + CSS.escape(rows()[index]?.node.id ?? "") + '"] .execution-node-button',
                  )
                  ?.focus(),
              )
            }}
          >
            {(line) => (
              <Show
                when={!line.branch}
                fallback={
                  <button
                    type="button"
                    class="execution-branch-more"
                    style={{ "padding-left": 16 + line.depth * 16 + "px" }}
                    disabled={branches().get(line.branch!)?.loading}
                    onClick={() => void loadBranch(line.node, !branches().get(line.branch!)?.error)}
                  >
                    {_(
                      branches().get(line.branch!)?.error
                        ? E.retry
                        : branches().get(line.branch!)?.loading
                          ? E.loading
                          : E.next,
                    )}
                  </button>
                }
              >
                <div
                  class="execution-node"
                  data-node-id={line.node.id}
                  data-kind={line.node.kind}
                  data-selected={selected() === line.node.id}
                  data-depth={line.depth}
                  style={{ "padding-left": 12 + line.depth * 16 + "px" }}
                >
                  <div class="execution-node-line">
                    <Show when={line.node.kind === "subtask"}>
                      <button
                        type="button"
                        class="execution-expand-task"
                        aria-label={line.node.title}
                        aria-expanded={expandedTasks().has(line.node.id)}
                        onClick={() => toggleTask(line.node)}
                      >
                        {expandedTasks().has(line.node.id) ? "−" : "+"}
                      </button>
                    </Show>
                    <button type="button" class="execution-node-button" onClick={() => select(line.node.id)}>
                      <Icon name={getSemanticIcon(glyphs[line.node.kind])} size="small" />
                      <span class="execution-node-body">
                        <small>
                          {_(K[line.node.kind])}
                          <Show when={query() && line.node.ancestors?.some((ancestor) => ancestor.kind === "subtask")}>
                            {" "}
                            ·{" "}
                            {line.node.ancestors
                              ?.filter((ancestor) => ancestor.kind === "subtask")
                              .map((ancestor) => ancestor.title)
                              .join(" / ")}
                          </Show>
                          <Show when={line.node.attribution === "unassigned"}> · {_(E.unassigned)}</Show>
                        </small>
                        <strong>{title(line.node)}</strong>
                        <Show when={line.node.group?.retryCount && line.node.kind !== "retry"}>
                          <small>{_({ ...E.retries, values: { count: line.node.group!.retryCount } })}</small>
                        </Show>
                      </span>
                      <span class="execution-node-meta">
                        <small data-state={nodeExecution(line.node)?.status ?? line.node.status}>
                          <Show
                            when={["failed", "cancelled", "interrupted"].includes(
                              nodeExecution(line.node)?.status ?? line.node.status,
                            )}
                          >
                            <Icon name={getSemanticIcon("state.error")} size="small" />
                          </Show>
                          {_(E[nodeExecution(line.node)?.status ?? line.node.status])}
                        </small>
                        <Show when={nodeDuration(line.node)}>{(duration) => <span>{duration()}</span>}</Show>
                        <Show when={line.node.kind === "subtask" && line.node.tokens?.known}>
                          <span>
                            {new Intl.NumberFormat(i18n().locale, {
                              notation: "compact",
                              maximumFractionDigits: 1,
                            }).format(line.node.tokens!.known)}
                          </span>
                        </Show>
                      </span>
                    </button>
                  </div>
                </div>
              </Show>
            )}
          </VList>
          <Show when={trajectory.state.next}>
            <button
              type="button"
              class="execution-page-link"
              disabled={trajectory.state.loading}
              onClick={() => void trajectory.load(trajectory.state.next!, undefined, "next")}
            >
              {_(E.next)}
            </button>
          </Show>
          <Show when={pending() || trajectory.state.history}>
            <button type="button" class="execution-new-events" onClick={() => void latest()}>
              {pending() ? _({ ...E.newEvents, values: { count: pending() } }) : _(E.latest)}
            </button>
          </Show>
        </div>
        <Show when={selected() && active()}>
          <ExecutionInspector
            sessionID={params.id!}
            nodeID={selected()}
            runID={runID() || undefined}
            filtered={!node()}
            executor={
              node()?.agent ||
              (node()?.sessionID === params.id
                ? _(E.own)
                : summary()?.tasks.find((task) => task.sessionID === node()?.sessionID)?.title)
            }
            revision={node()?.revision ?? summary()?.revision ?? 0}
            onBack={back}
            onSelect={(id) => select(id, true)}
          />
        </Show>
      </div>
    </div>
  )
}

export function ExecutionWorkbenchContent(props: WorkbenchPanelContentProps) {
  const dialog = useDialog()
  const { _ } = useLingui()
  const [expanded, setExpanded] = createSignal(false)
  const expand = () => {
    setExpanded(true)
    dialog.show(
      () => (
        <Dialog title={_(E.title)} size="wide" class="execution-expanded-dialog">
          <ExecutionPanelBody {...props} expanded />
        </Dialog>
      ),
      () => setExpanded(false),
    )
  }
  return <ExecutionPanelBody {...props} active={() => !expanded()} onExpand={expand} />
}
