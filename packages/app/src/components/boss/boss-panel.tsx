import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { WorkflowRun, WorkflowEntity, WorkflowEvent, WorkflowCharter } from "@ericsanchezok/synergy-sdk/client"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { cancelWorkflowRunConfirm } from "@/components/dialog/confirm-copy"
import type { ScopedSDK } from "@/context/sdk"
import { BossData } from "./boss-data"

const ICON = {
  boss: getSemanticIcon("performance.network"),
  gate: getSemanticIcon("holos.branch"),
  add: getSemanticIcon("action.add"),
  toEntity: getSemanticIcon("navigation.forward"),
  activity: getSemanticIcon("performance.trace"),
  entities: getSemanticIcon("blueprint.main"),
  seats: getSemanticIcon("agents.main"),
} satisfies Record<string, IconName>

/** Visual accent for an entity state — a coloured dot + subtle tint. */
function stateAccent(state: string): { dot: string; text: string } {
  if (state === "blocked" || state === "failed")
    return { dot: "bg-icon-critical-base", text: "text-icon-critical-base" }
  if (state === "merged" || state === "done" || state === "completed")
    return { dot: "bg-icon-success-base", text: "text-icon-success-base" }
  if (state === "awaiting_merge") return { dot: "bg-icon-warning-base", text: "text-icon-warning-base" }
  if (state === "queued" || state === "backlog" || state === "pending")
    return { dot: "bg-border-strong-base", text: "text-text-weak" }
  return { dot: "bg-icon-interactive-base", text: "text-text-interactive-base" }
}

function seatStatusDot(status: string): string {
  if (status === "working") return "bg-icon-success-base animate-pulse"
  if (status === "waiting") return "bg-icon-warning-base"
  if (status === "idle") return "bg-icon-interactive-base"
  return "bg-border-strong-base"
}

function statusPill(status: string): { label: string; class: string } {
  switch (status) {
    case "active":
      return { label: "active", class: "bg-surface-success-weak text-icon-success-base" }
    case "paused":
      return { label: "paused", class: "bg-surface-warning-weak text-icon-warning-base" }
    case "failed":
      return { label: "failed", class: "bg-surface-critical-weak text-icon-critical-base" }
    case "cancelled":
      return { label: "cancelled", class: "bg-surface-raised-base text-text-weak" }
    default:
      return { label: status, class: "bg-surface-raised-base text-text-base" }
  }
}

function SectionHeader(props: { icon: IconName; title: string; count?: number }) {
  return (
    <div class="flex items-center gap-1.5 text-11-medium uppercase tracking-wide text-text-weak">
      <Icon name={props.icon} size="small" class="text-text-weak" />
      <span>{props.title}</span>
      <Show when={props.count !== undefined}>
        <span class="rounded bg-surface-raised-base px-1 text-text-weak">{props.count}</span>
      </Show>
    </div>
  )
}

/**
 * Structural SDK shape the Boss panel depends on. The host passes the real
 * scoped SDK (from useSDK) cast to this — same decoupling pattern as
 * LatticePanelSDK.
 */
export type BossPanelSDK = Pick<ScopedSDK, "event"> & {
  client: Pick<ScopedSDK["client"], "workflowRun" | "workflowCharter">
}

export function BossPanel(props: { sdk: BossPanelSDK; sessionID?: string; reconnectVersion?: number }) {
  const confirm = useConfirm()
  const [runs, setRuns] = createSignal<WorkflowRun[]>([])
  const [selectedRunID, setSelectedRunID] = createSignal<string | undefined>()
  const [runsLoaded, setRunsLoaded] = createSignal(false)
  const [runListError, setRunListError] = createSignal<string | undefined>()
  const [chartersByRun, setChartersByRun] = createSignal(new Map<string, WorkflowCharter>())
  const [eventsByRun, setEventsByRun] = createSignal(new Map<string, WorkflowEvent[]>())
  const [charterError, setCharterError] = createSignal<string | undefined>()
  const [eventsError, setEventsError] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [cancelConfirmOpen, setCancelConfirmOpen] = createSignal(false)
  const [newIssue, setNewIssue] = createSignal("")
  const [timelineOpen, setTimelineOpen] = createSignal(false)

  // list() already returns full run objects, so the selected run is derived
  // directly from the list — no separate get() round-trip that could return null
  // and blank the whole panel.
  const run = createMemo(() => runs().find((r) => r.id === selectedRunID()) ?? runs()[0] ?? null)
  const runListState = createMemo(() => BossData.runListState(runsLoaded(), runs()))
  const charter = createMemo(() => {
    const selected = run()
    return selected ? (chartersByRun().get(selected.id) ?? null) : null
  })
  const events = createMemo(() => {
    const selected = run()
    return selected ? (eventsByRun().get(selected.id) ?? []) : []
  })
  const detailError = createMemo(() => [charterError(), eventsError()].filter(Boolean).join(" "))
  const runListRequest = BossData.createLatestRequestRunner()
  const charterRequest = BossData.createLatestRequestRunner()
  const eventsRequest = BossData.createLatestRequestRunner()
  let liveRunSequence = 0
  const liveRunsByID = new Map<string, { sequence: number; run: WorkflowRun }>()

  const loadRuns = (sessionID: string | undefined) => {
    const baseline = runs()
    const requestSequence = liveRunSequence
    setRunListError(undefined)
    return runListRequest.run(() => props.sdk.client.workflowRun.list(), {
      success: (res) => {
        if (props.sessionID !== sessionID) return
        const liveChanges = [...liveRunsByID.values()]
          .filter((entry) => entry.sequence > requestSequence || !BossData.isActive(entry.run))
          .sort((a, b) => a.sequence - b.sequence)
          .map((entry) => entry.run)
        const next = BossData.reconcileRunSnapshot(runs(), res.data ?? [], baseline, sessionID, liveChanges)
        setRuns(next)
        setSelectedRunID((selected) => BossData.selectRunID(next, selected))
        setRunsLoaded(true)
      },
      failure: () => {
        if (props.sessionID !== sessionID) return
        setRunsLoaded(true)
        setRunListError("Workflow runs could not be refreshed.")
      },
    })
  }

  const loadCharter = (selected: WorkflowRun) => {
    setCharterError(undefined)
    return charterRequest.run(
      () => props.sdk.client.workflowCharter.get({ id: selected.charterRef.id, version: selected.charterRef.version }),
      {
        success: (res) => {
          const nextCharter = res.data
          if (!nextCharter) {
            setCharterError("The workflow charter could not be refreshed.")
            return
          }
          setChartersByRun((current) => {
            const next = new Map(current)
            next.set(selected.id, nextCharter)
            return next
          })
        },
        failure: () => setCharterError("The workflow charter could not be refreshed."),
      },
    )
  }

  const loadEvents = (selected: WorkflowRun) => {
    setEventsError(undefined)
    return eventsRequest.run(
      (signal) =>
        BossData.collectEventPages(async (after) => {
          const response = await props.sdk.client.workflowRun.events({ id: selected.id, after }, { signal })
          return response.data ?? { items: [] }
        }, signal),
      {
        success: (snapshot) => {
          setEventsByRun((current) => {
            const next = new Map(current)
            next.set(selected.id, BossData.mergeEventSnapshot(current.get(selected.id) ?? [], snapshot))
            return next
          })
        },
        failure: () => setEventsError("Workflow activity could not be refreshed."),
      },
    )
  }

  let activeSessionID: string | undefined
  createEffect(() => {
    // Re-fetch authoritative snapshot after websocket reconnect so missed
    // run.created / run.updated / event.appended envelopes cannot leave the
    // panel permanently stale.
    void props.reconnectVersion
    const sessionID = props.sessionID
    if (activeSessionID !== sessionID) {
      activeSessionID = sessionID
      setRuns([])
      setSelectedRunID(undefined)
      setRunListError(undefined)
      setChartersByRun(new Map())
      setEventsByRun(new Map())
      setCharterError(undefined)
      setEventsError(undefined)
      setRunsLoaded(false)
      liveRunSequence = 0
      liveRunsByID.clear()
    }
    if (!sessionID) {
      runListRequest.cancel()
      setRunsLoaded(true)
      return
    }
    void loadRuns(sessionID)

    const reconcileRun = (incoming: WorkflowRun) => {
      if (incoming.bossSessionID !== sessionID) return
      const known = liveRunsByID.get(incoming.id)?.run ?? runs().find((item) => item.id === incoming.id)
      const latest = BossData.latestRun(known, incoming)
      if (known && latest === known) return
      liveRunSequence += 1
      liveRunsByID.set(incoming.id, { sequence: liveRunSequence, run: latest })
      const next = BossData.reconcileActiveRun(runs(), latest, sessionID)
      setRuns(next)
      setSelectedRunID((selected) => BossData.selectRunID(next, selected))
    }
    const unsubCreated = props.sdk.event.on("workflow.run.created", (event) => {
      const created = event.properties.run
      if (!created) return
      reconcileRun(created)
    })
    const unsubRun = props.sdk.event.on("workflow.run.updated", (event) => {
      const updated = event.properties.run
      if (!updated) return
      reconcileRun(updated)
    })
    const unsubEvent = props.sdk.event.on("workflow.event.appended", (event) => {
      const appended = event.properties.event
      if (!appended || !runs().some((item) => item.id === appended.runID)) return
      setEventsByRun((current) => {
        const next = new Map(current)
        next.set(appended.runID, BossData.mergeEvents(current.get(appended.runID) ?? [], [appended]))
        return next
      })
    })
    onCleanup(() => {
      unsubCreated()
      unsubRun()
      unsubEvent()
    })
  })

  let detailKey: string | undefined
  createEffect(() => {
    const reconnectVersion = props.reconnectVersion ?? 0
    const selected = run()
    const nextKey = selected
      ? `${selected.id}:${selected.charterRef.id}:${selected.charterRef.version}:${reconnectVersion}`
      : undefined
    if (nextKey === detailKey) return
    detailKey = nextKey
    setCharterError(undefined)
    setEventsError(undefined)
    if (!selected) {
      charterRequest.cancel()
      eventsRequest.cancel()
      return
    }
    void loadCharter(selected)
    void loadEvents(selected)
  })

  onCleanup(() => {
    runListRequest.cancel()
    charterRequest.cancel()
    eventsRequest.cancel()
  })

  const stateOrder = createMemo(() => charter()?.states ?? [])
  const board = createMemo(() => {
    const r = run()
    return r ? BossData.entitiesByState(r, stateOrder()) : []
  })
  const gates = createMemo(() => {
    const r = run()
    return r ? BossData.pendingGates(r) : []
  })

  const gateResolutions = (gateName: string): string[] =>
    charter()?.gates?.find((g) => g.name === gateName)?.resolutions ?? ["merge", "rework"]

  const resolveGate = async (gid: string, resolution: string) => {
    const id = selectedRunID()
    if (!id) return
    setBusy(true)
    try {
      await props.sdk.client.workflowRun.gate.resolve({ id, gid, resolution })
    } catch (err) {
      showToast({
        type: "error",
        title: "Gate action failed",
        description: err instanceof Error ? err.message : "Unknown",
      })
    } finally {
      setBusy(false)
    }
  }

  const performControl = async (id: string, action: "pause" | "resume" | "cancel") => {
    setBusy(true)
    try {
      await props.sdk.client.workflowRun.control({ id, action })
    } finally {
      setBusy(false)
    }
  }

  const control = async (action: "pause" | "resume") => {
    const id = selectedRunID()
    if (!id) return
    try {
      await performControl(id, action)
    } catch (err) {
      showToast({ type: "error", title: "Control failed", description: err instanceof Error ? err.message : "Unknown" })
    }
  }

  const requestCancel = () => {
    const current = run()
    if (!current || busy() || cancelConfirmOpen()) return

    setCancelConfirmOpen(true)
    confirm.show({
      ...cancelWorkflowRunConfirm(current.title),
      onConfirm: () => performControl(current.id, "cancel"),
      onConfirmed: () => setCancelConfirmOpen(false),
      onDismiss: () => setCancelConfirmOpen(false),
    })
  }

  const createRun = async () => {
    if (!props.sessionID) {
      showToast({
        type: "error",
        title: "Open a session first",
        description: "A Boss run is owned by the current session.",
      })
      return
    }
    setBusy(true)
    try {
      const res = await props.sdk.client.workflowRun.create({
        charterID: "cht_builtin_issue_to_pr",
        title: "Issue → PR → Test",
        bossSessionID: props.sessionID,
      })
      if (res.data) setSelectedRunID(res.data.id)
      await loadRuns(props.sessionID)
    } catch (err) {
      showToast({ type: "error", title: "Create failed", description: err instanceof Error ? err.message : "Unknown" })
    } finally {
      setBusy(false)
    }
  }

  const addEntity = async () => {
    const id = selectedRunID()
    const title = newIssue().trim()
    if (!id || !title) return
    setBusy(true)
    try {
      await props.sdk.client.workflowRun.entity.add({ id, title })
      setNewIssue("")
    } catch (err) {
      showToast({ type: "error", title: "Add failed", description: err instanceof Error ? err.message : "Unknown" })
    } finally {
      setBusy(false)
    }
  }

  const retryDetails = () => {
    const selected = run()
    if (!selected) return
    if (charterError()) void loadCharter(selected)
    if (eventsError()) void loadEvents(selected)
  }

  return (
    <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-13-regular text-text-base">
      <Show when={runListError()}>
        {(message) => <LoadError message={message()} onRetry={() => void loadRuns(props.sessionID)} />}
      </Show>
      <Show
        when={runListState() !== "loading"}
        fallback={
          <div class="flex flex-col items-center gap-3 px-2 py-8 text-center text-text-weak">
            <span>Loading workflow runs…</span>
          </div>
        }
      >
        <Show
          when={runListState() === "ready" && run()}
          fallback={
            <div class="flex flex-col items-center gap-3 px-2 py-8 text-center text-text-weak">
              <Show
                when={!runListError()}
                fallback={<span>Workflow runs are unavailable. Retry the refresh above.</span>}
              >
                <span>No active workflow runs for this session.</span>
                <Button size="small" variant="primary" disabled={busy()} onClick={createRun}>
                  Start Issue → PR → Test run
                </Button>
              </Show>
            </div>
          }
        >
          {(r) => {
            const pill = () => statusPill(r().status)
            const budgetPct = () =>
              r().budget.maxModelCalls > 0
                ? Math.min(100, Math.round((r().budget.used / r().budget.maxModelCalls) * 100))
                : 0
            return (
              <>
                {/* Header: run identity + status + controls */}
                <header class="flex flex-col gap-2 rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
                  <div class="flex items-center gap-2">
                    <Icon name={ICON.boss} size="small" class="shrink-0 text-icon-interactive-base" />
                    <Show
                      when={runs().length > 1}
                      fallback={
                        <span class="min-w-0 flex-1 truncate text-13-semibold text-text-strong">{r().title}</span>
                      }
                    >
                      <select
                        class="min-w-0 flex-1 truncate rounded-md border border-border-weak-base bg-surface-base px-1.5 py-1 text-13-semibold text-text-strong"
                        value={selectedRunID() ?? ""}
                        onChange={(e) => setSelectedRunID(e.currentTarget.value)}
                      >
                        <For each={runs()}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                      </select>
                    </Show>
                    <span class={`shrink-0 rounded-full px-2 py-0.5 text-11-medium ${pill().class}`}>
                      {pill().label}
                    </span>
                  </div>

                  {/* Budget */}
                  <Show when={r().budget.maxModelCalls > 0}>
                    <div class="flex items-center gap-2">
                      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-base">
                        <div
                          class="h-full rounded-full bg-icon-interactive-base"
                          style={{ width: `${budgetPct()}%` }}
                        />
                      </div>
                      <span class="shrink-0 text-11-regular text-text-weak">
                        {r().budget.used}/{r().budget.maxModelCalls}
                      </span>
                    </div>
                  </Show>

                  {/* Controls */}
                  <div class="flex items-center gap-2">
                    <Show when={r().status === "active"}>
                      <Button size="small" variant="secondary" disabled={busy()} onClick={() => control("pause")}>
                        Pause
                      </Button>
                    </Show>
                    <Show when={r().status === "paused"}>
                      <Button size="small" variant="secondary" disabled={busy()} onClick={() => control("resume")}>
                        Resume
                      </Button>
                    </Show>
                    <div class="flex-1" />
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={busy() || cancelConfirmOpen()}
                      onClick={requestCancel}
                    >
                      Cancel run
                    </Button>
                  </div>
                </header>

                <Show when={detailError()}>
                  {(message) => <LoadError message={message()} onRetry={retryDetails} />}
                </Show>

                {/* Gates — the only thing that needs the human */}
                <Show when={gates().length > 0}>
                  <section class="flex flex-col gap-2 rounded-lg border border-border-warning-base/60 bg-surface-warning-weak/50 p-3">
                    <div class="flex items-center gap-1.5 text-12-semibold text-icon-warning-base">
                      <Icon name={ICON.gate} size="small" />
                      <span>Decisions needed</span>
                    </div>
                    <For each={gates()}>
                      {(gate) => {
                        const gateEntity = () => r().entities.find((e) => e.id === gate.entityID)
                        return (
                          <div class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-surface-raised-base p-2.5">
                            <div class="text-13-medium text-text-strong">{gateEntity()?.title ?? gate.gate}</div>
                            <Show when={gate.context}>
                              <pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-base p-2 text-11-regular text-text-weak">
                                {gate.context}
                              </pre>
                            </Show>
                            <div class="flex flex-wrap gap-2">
                              <For each={gateResolutions(gate.gate)}>
                                {(resolution) => (
                                  <Button
                                    size="small"
                                    variant={resolution === "merge" ? "primary" : "secondary"}
                                    disabled={busy()}
                                    onClick={() => resolveGate(gate.id, resolution)}
                                  >
                                    {resolution}
                                  </Button>
                                )}
                              </For>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </section>
                </Show>

                {/* Enqueue */}
                <section class="flex gap-2">
                  <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-raised-base px-2">
                    <Icon name={ICON.add} size="small" class="shrink-0 text-text-weak" />
                    <input
                      class="min-w-0 flex-1 bg-transparent py-1.5 text-13-regular outline-none placeholder:text-text-weak"
                      placeholder="Enqueue an issue…"
                      value={newIssue()}
                      onInput={(e) => setNewIssue(e.currentTarget.value)}
                      onKeyDown={(e) => e.key === "Enter" && addEntity()}
                    />
                  </div>
                  <Button size="small" variant="primary" disabled={busy() || !newIssue().trim()} onClick={addEntity}>
                    Add
                  </Button>
                </section>

                {/* Entity board */}
                <section class="flex flex-col gap-2">
                  <SectionHeader icon={ICON.entities} title="Entities" count={r().entities.length} />
                  <Show
                    when={r().entities.length > 0}
                    fallback={<div class="px-1 text-12-regular text-text-weak">No work enqueued yet.</div>}
                  >
                    <For each={board()}>
                      {(group) => (
                        <Show when={group.entities.length > 0}>
                          <div class="flex flex-col gap-1">
                            <div class={`flex items-center gap-1.5 text-11-medium ${stateAccent(group.state).text}`}>
                              <span class={`inline-block h-2 w-2 rounded-full ${stateAccent(group.state).dot}`} />
                              <span>{group.state.replace(/_/g, " ")}</span>
                              <span class="text-text-weak">· {group.entities.length}</span>
                            </div>
                            <div class="flex flex-col gap-1 pl-3.5">
                              <For each={group.entities}>{(entity) => <EntityCard entity={entity} />}</For>
                            </div>
                          </div>
                        </Show>
                      )}
                    </For>
                  </Show>
                </section>

                {/* Seats */}
                <section class="flex flex-col gap-1.5">
                  <SectionHeader icon={ICON.seats} title="Seats" />
                  <div class="flex flex-col gap-1">
                    <For each={r().seats}>
                      {(seat) => (
                        <div class="flex items-center gap-2 rounded-md px-1.5 py-1 text-12-regular hover:bg-surface-raised-base-hover">
                          <span
                            class={`inline-block h-2 w-2 shrink-0 rounded-full ${seatStatusDot(seat.status ?? "unbound")}`}
                          />
                          <span class="text-text-base">
                            {seat.seat}
                            <span class="text-text-weak">#{seat.instance}</span>
                          </span>
                          <Show when={seat.entityID}>
                            <Icon name={ICON.toEntity} size="small" class="text-text-weak" />
                            <span class="min-w-0 flex-1 truncate text-text-weak">
                              {r().entities.find((e) => e.id === seat.entityID)?.title ?? seat.entityID}
                            </span>
                          </Show>
                          <div class="flex-1" />
                          <span class="shrink-0 text-11-regular text-text-weak">{seat.status}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </section>

                {/* Timeline */}
                <section class="flex flex-col gap-1">
                  <button
                    type="button"
                    class="flex items-center gap-1.5 text-11-medium uppercase tracking-wide text-text-weak"
                    onClick={() => setTimelineOpen((v) => !v)}
                  >
                    <Icon
                      name={timelineOpen() ? "chevron-down" : "chevron-right"}
                      size="small"
                      class="text-text-weak"
                    />
                    <Icon name={ICON.activity} size="small" class="text-text-weak" />
                    <span>Activity</span>
                    <span class="rounded bg-surface-raised-base px-1 text-text-weak">{events().length}</span>
                  </button>
                  <Show when={timelineOpen()}>
                    <div class="flex flex-col gap-0.5 border-l border-border-weak-base pl-2.5">
                      <For each={[...events()].reverse().slice(0, 80)}>
                        {(event) => {
                          const tone = BossData.eventTone(event.kind)
                          return (
                            <div
                              class={`text-11-regular ${tone === "error" ? "text-icon-critical-base" : tone === "warn" ? "text-icon-warning-base" : "text-text-weak"}`}
                            >
                              {BossData.eventLabel(event)}
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </section>
              </>
            )
          }}
        </Show>
      </Show>
    </div>
  )
}

function LoadError(props: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      class="flex items-center gap-2 rounded-md border border-border-critical-base/40 bg-surface-critical-weak px-2.5 py-2 text-12-regular text-text-on-critical-base"
    >
      <span class="min-w-0 flex-1">{props.message}</span>
      <Button size="small" variant="ghost" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  )
}

function EntityCard(props: { entity: WorkflowEntity }) {
  const accent = () => stateAccent(props.entity.state)
  return (
    <div class="flex flex-col gap-0.5 rounded-md border border-border-weak-base bg-surface-raised-base px-2 py-1.5">
      <div class="flex items-center gap-2">
        <span class={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${accent().dot}`} />
        <span class="min-w-0 flex-1 truncate text-12-medium text-text-strong">{props.entity.title}</span>
        <Show when={props.entity.assignedSeat}>
          {(seat) => (
            <span class="shrink-0 rounded bg-surface-base px-1 text-11-regular text-text-weak">
              {seat().seat}#{seat().instance}
            </span>
          )}
        </Show>
      </div>
      <Show when={props.entity.blockedReason}>
        <div class="pl-3.5 text-11-regular text-icon-critical-base">{props.entity.blockedReason}</div>
      </Show>
      <Show when={props.entity.bindings?.prNumber}>
        <div class="pl-3.5 text-11-regular text-text-weak">PR #{props.entity.bindings?.prNumber}</div>
      </Show>
    </div>
  )
}
