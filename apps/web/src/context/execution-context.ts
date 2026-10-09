import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { ExecutionContextSnapshot, EventExecutionUpdated, SynergyClient } from "@ericsanchezok/synergy-sdk/client"

export function mergeContextHistory(
  current: ExecutionContextSnapshot[],
  updates: ExecutionContextSnapshot[],
  older = false,
) {
  const values = new Map(current.map((entry) => [entry.callID, entry]))
  for (const entry of updates) values.set(entry.callID, entry)
  const sorted = [...values.values()].sort((a, b) => b.started - a.started || b.callID.localeCompare(a.callID))
  return older ? sorted.slice(-300) : sorted.slice(0, 300)
}

export function createExecutionContext(input: {
  client: SynergyClient
  sessionID: Accessor<string | undefined>
  runID: Accessor<string>
  active: Accessor<boolean>
  connectionVersion: Accessor<number>
  selected: Accessor<string>
  subscribe: (receive: (event: EventExecutionUpdated["properties"]) => void) => () => void
}) {
  const [state, setState] = createStore<{
    items: ExecutionContextSnapshot[]
    latest?: ExecutionContextSnapshot
    retained?: ExecutionContextSnapshot
    revision: number
    total: number
    nextCursor: string | null
    loading: boolean
    error: boolean
  }>({ items: [], revision: -1, total: 0, nextCursor: null, loading: false, error: false })
  let request = 0
  let abort: AbortController | undefined
  let selectionAbort: AbortController | undefined
  let pendingUpdates = new Map<string, ExecutionContextSnapshot>()
  let browsingEarlier = false
  const snapshot = createMemo(() =>
    input.selected()
      ? (state.items.find((entry) => entry.callID === input.selected()) ??
        (state.retained?.callID === input.selected() ? state.retained : undefined))
      : state.latest,
  )
  const setSnapshot = (slot: "latest" | "retained", next: ExecutionContextSnapshot) => {
    if (state[slot]?.callID === next.callID) {
      setState(slot, reconcile(next))
      return
    }
    setState(
      produce((state) => {
        state[slot] = next
      }),
    )
  }
  const retain = (entries: ExecutionContextSnapshot[]) => {
    const selected = entries.find((entry) => entry.callID === input.selected())
    if (selected) setSnapshot("retained", selected)
    const latest = entries.reduce<ExecutionContextSnapshot | undefined>(
      (result, entry) => (!result || entry.started >= result.started ? entry : result),
      undefined,
    )
    if (latest && (!state.latest || latest.started >= state.latest.started)) setSnapshot("latest", latest)
  }
  const load = async (older = false, reset = false) => {
    const sessionID = input.sessionID()
    if (!sessionID || !input.active()) return
    const current = ++request
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    const updates = new Map<string, ExecutionContextSnapshot>()
    pendingUpdates = updates
    setState({ loading: true, error: false })
    try {
      const response = await input.client.session.executionContextHistory(
        {
          sessionID,
          runID: input.runID() || undefined,
          cursor: older ? (state.nextCursor ?? undefined) : undefined,
          limit: 30,
        },
        { signal: controller.signal, throwOnError: true },
      )
      if (current !== request || controller.signal.aborted) return
      const page = response.data
      const incoming = mergeContextHistory(page.items, [...updates.values()])
      retain(incoming)
      browsingEarlier = !reset && (older || browsingEarlier)
      const known = new Set(state.items.map((entry) => entry.callID))
      const entries = browsingEarlier && !older ? incoming.filter((entry) => known.has(entry.callID)) : incoming
      setState(
        "items",
        reconcile(mergeContextHistory(reset ? [] : state.items, entries, browsingEarlier), { key: "callID" }),
      )
      const added = [...updates.values()].filter(
        (entry) => page.items.length && entry.started > page.items[0].started,
      ).length
      setState({ revision: Math.max(page.revision, state.revision), total: Math.max(state.total, page.total + added) })
      if (older || !browsingEarlier) setState("nextCursor", page.nextCursor)
    } catch {
      if (current === request && !controller.signal.aborted) setState("error", true)
    } finally {
      if (current === request) {
        pendingUpdates.clear()
        setState("loading", false)
      }
    }
  }
  createEffect(
    on([input.sessionID, input.runID], () => {
      request++
      abort?.abort()
      selectionAbort?.abort()
      browsingEarlier = false
      setState({
        items: [],
        latest: undefined,
        retained: undefined,
        revision: -1,
        nextCursor: null,
        total: 0,
        error: false,
      })
    }),
  )
  createEffect(
    on([input.sessionID, input.runID, input.active, input.connectionVersion], () => {
      if (input.active()) void load()
      else {
        request++
        abort?.abort()
        setState("loading", false)
      }
    }),
  )
  createEffect(
    on([input.selected, input.active, () => state.loading, input.connectionVersion], async () => {
      selectionAbort?.abort()
      const sessionID = input.sessionID()
      const callID = input.selected()
      if (!sessionID || !callID || !input.active() || state.loading) return
      const known = state.items.find((entry) => entry.callID === callID)
      if (known) {
        setSnapshot("retained", known)
        return
      }
      const controller = new AbortController()
      selectionAbort = controller
      try {
        const revision = state.revision
        const response = await input.client.session.executionContextSnapshot(
          { sessionID, callID, runID: input.runID() || undefined },
          { signal: controller.signal, throwOnError: true },
        )
        if (
          !controller.signal.aborted &&
          input.selected() === callID &&
          (state.revision === revision || state.retained?.callID !== callID)
        )
          retain([response.data])
      } catch {
        if (!controller.signal.aborted) setState("error", true)
      }
    }),
  )
  const unsubscribe = input.subscribe((event) => {
    if (!input.active() || event.sessionID !== input.sessionID() || event.revision <= state.revision) return
    const updates = (event.contextUpserts ?? []).filter((entry) => !input.runID() || entry.runID === input.runID())
    if (state.loading) for (const entry of updates) pendingUpdates.set(entry.callID, entry)
    const added = updates.filter((entry) => !state.latest || entry.started > state.latest.started).length
    retain(updates)
    const known = new Set(state.items.map((entry) => entry.callID))
    setState(
      "items",
      reconcile(
        mergeContextHistory(
          state.items,
          browsingEarlier ? updates.filter((entry) => known.has(entry.callID)) : updates,
        ),
        { key: "callID" },
      ),
    )
    setState({ revision: event.revision, total: state.total + added })
  })
  onCleanup(() => {
    request++
    abort?.abort()
    selectionAbort?.abort()
    unsubscribe()
  })
  return { state, snapshot, load }
}
