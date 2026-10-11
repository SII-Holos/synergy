import { newerExecutionSample } from "@/utils/execution-time"
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { ExecutionSummary, ExecutionTrajectoryNode } from "@ericsanchezok/synergy-sdk/client"
import type { SDKContext } from "@/context/sdk"
import { executionOrder, executionWindowMatches, mergeExecutionWindow } from "./window"

export function createExecutionTrajectory(input: {
  sdk: Pick<SDKContext, "client" | "event">
  sessionID: Accessor<string | undefined>
  runID: Accessor<string>
  actor: Accessor<string>
  kind: Accessor<ExecutionTrajectoryNode["kind"] | "">
  status: Accessor<ExecutionTrajectoryNode["status"] | "">
  query: Accessor<string>
  anchor: Accessor<string>
  connectionVersion: Accessor<number>
  enabled?: Accessor<boolean>
  mode?: Accessor<"process" | "records">
  kinds?: Accessor<string>
  statuses?: Accessor<string>
  anomalies?: Accessor<boolean>
  order?: Accessor<"time" | "round" | "call">
  capacity?: Accessor<number>
  rounds?: Accessor<ExecutionSummary["rounds"]>
}) {
  const [state, setState] = createStore({
    rows: [] as ExecutionTrajectoryNode[],
    revision: -1,
    total: 0,
    next: null as string | null,
    previous: null as string | null,
    loading: false,
    error: false,
    pending: 0,
    history: false,
    summary: undefined as ExecutionSummary | undefined,
  })
  const [generation, setGeneration] = createSignal(0)
  let abort: AbortController | undefined
  let disposed = false
  let selectionKey = ""
  let wasEnabled = false
  let connection = -1
  let buffered = new Map<string, ExecutionTrajectoryNode>()
  let removed = new Set<string>()
  const unseen = new Set<string>()
  const compare = () =>
    executionOrder(
      input.order?.() ?? "time",
      new Map((input.rounds?.() ?? state.summary?.rounds ?? []).map((round, index) => [round.id, index])),
    )
  const load = async (cursor?: string, anchor?: string, direction?: "next" | "previous", restore = false) => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    const version = generation() + 1
    const reading = state.history
    setGeneration(version)
    buffered = new Map()
    removed = new Set()
    if (!direction) unseen.clear()
    setState({ loading: true, error: false })
    try {
      const response = await input.sdk.client.session.executionTrajectory(
        {
          sessionID,
          runID: input.runID() || undefined,
          session: input.actor() && input.actor() !== "all" ? input.actor() : undefined,
          actor: input.actor() === "all" || (input.query() && !input.actor()) ? "all" : "main",
          kind: input.kind() || undefined,
          mode: input.mode?.() ?? "records",
          kinds: input.kinds?.() || undefined,
          statuses: input.statuses?.() || undefined,
          anomalies: input.anomalies?.() ?? false,
          order: input.order?.() ?? "time",
          status: input.status() || undefined,
          query: input.query() || undefined,
          cursor: direction && state.rows.length ? undefined : cursor,
          anchor:
            direction && state.rows.length
              ? direction === "previous"
                ? state.rows[0].id
                : state.rows.at(-1)!.id
              : anchor,
          position: direction ? (direction === "previous" ? "before" : "after") : undefined,
          limit: restore ? Math.min(input.capacity?.() ?? 500, Math.max(100, state.rows.length)) : 100,
        },
        { signal: controller.signal, throwOnError: true },
      )
      if (disposed || generation() !== version) return
      const page = response.data
      const rows = direction
        ? mergeExecutionWindow(state.rows, page.items, [], {
            history: direction === "previous",
            cap: input.capacity?.() ?? 500,
            compare: compare(),
          }).rows
        : page.items
      // Paging explicitly admits new history rows, unlike live updates.
      const paged =
        direction === "previous"
          ? [...new Map([...page.items, ...state.rows].map((row) => [row.id, row])).values()]
              .sort(compare())
              .slice(0, input.capacity?.() ?? 500)
          : rows
      const merged = mergeExecutionWindow(paged, [...buffered.values()], [...removed], {
        history: (restore && reading) || !!page.nextCursor,
        cap: input.capacity?.() ?? 500,
        compare: compare(),
      })
      setState("rows", reconcile(merged.rows))
      setState({
        total: page.total,
        revision: Math.max(state.revision, page.revision),
        loading: false,
        next: direction === "previous" && paged.length < 500 ? state.next : page.nextCursor,
        previous: direction === "next" && paged.length < 500 ? state.previous : page.previousCursor,
        history: (restore && reading) || !!page.nextCursor || direction === "previous",
        pending: direction || restore ? state.pending : 0,
      })
    } catch {
      if (!disposed && generation() === version && !controller.signal.aborted) setState({ loading: false, error: true })
    } finally {
      if (!disposed && generation() === version) setState("loading", false)
    }
  }
  const refreshSummary = async () => {
    const sessionID = input.sessionID()
    const runID = input.runID()
    if (!sessionID) return
    if (!runID) {
      setState("summary", undefined)
      return
    }
    try {
      const response = await input.sdk.client.session.executionSummary(
        { sessionID, runID },
        { signal: abort?.signal, throwOnError: true },
      )
      if (
        !disposed &&
        input.sessionID() === sessionID &&
        input.runID() === runID &&
        newerExecutionSample(state.summary, response.data, true)
      )
        setState("summary", reconcile(response.data))
    } catch {
      if (!disposed && !abort?.signal.aborted) setState("error", true)
    }
  }
  createEffect(
    on(
      [
        input.sessionID,
        input.runID,
        input.actor,
        input.kind,
        input.status,
        input.query,
        input.anchor,
        input.connectionVersion,
        () => input.mode?.(),
        () => input.kinds?.(),
        () => input.statuses?.(),
        () => input.anomalies?.(),
        () => input.order?.(),
        () => input.enabled?.() ?? true,
      ],
      () => {
        if (input.enabled?.() === false) {
          wasEnabled = false
          abort?.abort()
          setState("loading", false)
          return
        }
        const key = JSON.stringify([
          input.sessionID(),
          input.runID(),
          input.actor(),
          input.kind(),
          input.status(),
          input.query(),
          input.anchor(),
          input.mode?.(),
          input.kinds?.(),
          input.statuses?.(),
          input.anomalies?.(),
          input.order?.(),
        ])
        const restoring = selectionKey === key && state.rows.length > 0
        const connectionChanged = connection !== input.connectionVersion()
        const recover = !wasEnabled || connectionChanged
        wasEnabled = true
        connection = input.connectionVersion()
        if (restoring) {
          if (recover) {
            if (connectionChanged) setState("revision", -1)
            void load(
              undefined,
              state.history ? state.rows[Math.floor(state.rows.length / 2)]?.id : "latest",
              undefined,
              true,
            )
            void refreshSummary()
          }
          return
        }
        selectionKey = key
        setState({ rows: [], revision: -1, next: null, previous: null, summary: undefined, pending: 0, history: false })
        void load(undefined, input.anchor() || (input.query() ? undefined : "latest"))
        void refreshSummary()
      },
    ),
  )
  const unsubscribe = input.sdk.event.on("execution.updated", (event) => {
    const update = event.properties
    if (input.enabled?.() === false) return
    if (update.sessionID !== input.sessionID() || update.revision <= state.revision) return
    if (update.previousRevision !== undefined && update.previousRevision > state.revision && !state.loading) {
      void load(
        undefined,
        state.history ? state.rows[Math.floor(state.rows.length / 2)]?.id : "latest",
        undefined,
        true,
      )
      return
    }
    const summary = input.runID() ? update.roundSummaries.find((value) => value.runID === input.runID()) : undefined
    if (summary && newerExecutionSample(state.summary, summary)) setState("summary", reconcile(summary))
    const runs = input.runID()
      ? new Set([
          input.sessionID() + ":" + input.runID(),
          ...((summary ?? state.summary)?.tasks.flatMap((task) => task.runs.map((run) => task.sessionID + ":" + run)) ??
            []),
        ])
      : undefined
    const parents = new Map(update.summary.tasks.map((task) => [task.sessionID, task.parentID]))
    const filter = {
      sessionID: input.sessionID()!,
      actor: input.query() && !input.actor() ? "all" : input.actor(),
      kind: input.kind(),
      status: input.status(),
      query: input.query(),
      runs,
      parents,
    }
    const accepts = (node: ExecutionTrajectoryNode) =>
      executionWindowMatches(node, filter) &&
      (!input.kinds?.() || input.kinds()!.split(",").includes(node.kind)) &&
      (!input.statuses?.() || input.statuses()!.split(",").includes(node.status)) &&
      (!input.anomalies?.() || node.kind === "retry" || ["failed", "cancelled", "interrupted"].includes(node.status))
    const updates = input.mode?.() === "process" ? (update.processUpserts ?? update.upserts) : update.upserts
    const removals =
      input.mode?.() === "process" ? [...update.removed, ...(update.processRemoved ?? [])] : update.removed
    const changed = updates.filter(accepts)
    const excluded = updates.filter((node) => !accepts(node)).map((node) => node.id)
    if (state.loading) {
      for (const node of changed) {
        buffered.set(node.id, node)
        removed.delete(node.id)
      }
      for (const id of [...removals, ...excluded]) {
        removed.add(id)
        buffered.delete(id)
      }
    }
    const result = mergeExecutionWindow(state.rows, changed, [...removals, ...excluded], {
      history: state.history || !!state.next,
      cap: input.capacity?.() ?? 500,
      compare: compare(),
    })
    const arrivals = changed.filter((node) => !state.rows.some((row) => row.id === node.id) && !unseen.has(node.id))
    for (const node of arrivals) unseen.add(node.id)
    setState("rows", reconcile(result.rows))
    setState({ revision: update.revision, pending: state.history ? state.pending + arrivals.length : state.pending })
  })
  createEffect(() => {
    const cap = input.capacity?.() ?? 500
    if (state.rows.length > cap)
      setState("rows", reconcile(state.history ? state.rows.slice(0, cap) : state.rows.slice(-cap)))
  })
  onCleanup(() => {
    disposed = true
    abort?.abort()
    unsubscribe()
  })
  return { state, load, setHistory: (value: boolean) => setState("history", value), refreshSummary }
}
