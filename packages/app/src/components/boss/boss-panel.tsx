import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { WorkflowRun, WorkflowEntity, WorkflowEvent, WorkflowCharter } from "@ericsanchezok/synergy-sdk/client"
import { BossData } from "./boss-data"

/**
 * Structural SDK shape the Boss panel depends on. The host passes the real
 * scoped SDK (from useSDK) cast to this — same decoupling pattern as
 * LatticePanelSDK.
 */
export interface BossPanelSDK {
  event: {
    on: (type: string, cb: (event: { properties: { run?: WorkflowRun; event?: WorkflowEvent } }) => void) => () => void
  }
  client: {
    workflowRun: {
      list: () => Promise<{ data?: WorkflowRun[] | null }>
      create: (input: {
        body: { charterID: string; title: string; bossSessionID: string }
      }) => Promise<{ data?: WorkflowRun | null }>
      get: (input: { path: { id: string } }) => Promise<{ data?: WorkflowRun | null }>
      events: (input: {
        path: { id: string }
        query?: { after?: string }
      }) => Promise<{ data?: WorkflowEvent[] | null }>
      control: (input: {
        path: { id: string }
        body: { action: "pause" | "resume" | "cancel" }
      }) => Promise<{ data?: WorkflowRun | null }>
      entity: {
        add: (input: {
          path: { id: string }
          body: { title: string; description?: string; affinityKey?: string }
        }) => Promise<{ data?: WorkflowEntity | null }>
      }
      gate: {
        resolve: (input: {
          path: { id: string; gid: string }
          body: { resolution: string }
        }) => Promise<{ data?: WorkflowRun | null }>
      }
    }
    workflowCharter: {
      get: (input: { path: { id: string; version: number } }) => Promise<{ data?: WorkflowCharter | null }>
    }
  }
}

export function BossPanel(props: { sdk: BossPanelSDK; sessionID?: string }) {
  const [runs, setRuns] = createSignal<WorkflowRun[]>([])
  const [selectedRunID, setSelectedRunID] = createSignal<string | undefined>()
  const [run, setRun] = createSignal<WorkflowRun | null>(null)
  const [charter, setCharter] = createSignal<WorkflowCharter | null>(null)
  const [events, setEvents] = createSignal<WorkflowEvent[]>([])
  const [busy, setBusy] = createSignal(false)
  const [newIssue, setNewIssue] = createSignal("")

  const loadRuns = async () => {
    const res = await props.sdk.client.workflowRun.list().catch(() => ({ data: [] }))
    const list = (res.data ?? []).filter(BossData.isActive)
    setRuns(list)
    // Prefer the run owned by the current session, else the first active run.
    if (!selectedRunID()) {
      const owned = list.find((r) => r.bossSessionID === props.sessionID)
      setSelectedRunID(owned?.id ?? list[0]?.id)
    }
  }

  const loadRun = async (runID: string) => {
    const res = await props.sdk.client.workflowRun.get({ path: { id: runID } }).catch(() => ({ data: null }))
    setRun(res.data ?? null)
    const r = res.data
    if (r) {
      const [charterRes, eventsRes] = await Promise.all([
        props.sdk.client.workflowCharter
          .get({ path: { id: r.charterRef.id, version: r.charterRef.version } })
          .catch(() => ({ data: null })),
        props.sdk.client.workflowRun.events({ path: { id: runID } }).catch(() => ({ data: [] })),
      ])
      setCharter(charterRes.data ?? null)
      setEvents(eventsRes.data ?? [])
    }
  }

  createEffect(() => {
    void loadRuns()
    const unsubRun = props.sdk.event.on("workflow.run.updated", (event) => {
      const updated = event.properties.run
      if (!updated) return
      setRuns((prev) => {
        const next = prev.filter((r) => r.id !== updated.id)
        if (BossData.isActive(updated)) next.push(updated)
        return next
      })
      if (updated.id === selectedRunID()) setRun(updated)
    })
    const unsubEvent = props.sdk.event.on("workflow.event.appended", (event) => {
      const appended = event.properties.event
      if (!appended || appended.runID !== selectedRunID()) return
      setEvents((prev) => BossData.mergeEvents(prev, [appended]))
    })
    onCleanup(() => {
      unsubRun()
      unsubEvent()
    })
  })

  createEffect(() => {
    const id = selectedRunID()
    if (id) void loadRun(id)
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
      await props.sdk.client.workflowRun.gate.resolve({ path: { id, gid }, body: { resolution } })
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

  const control = async (action: "pause" | "resume" | "cancel") => {
    const id = selectedRunID()
    if (!id) return
    setBusy(true)
    try {
      await props.sdk.client.workflowRun.control({ path: { id }, body: { action } })
    } catch (err) {
      showToast({ type: "error", title: "Control failed", description: err instanceof Error ? err.message : "Unknown" })
    } finally {
      setBusy(false)
    }
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
        body: { charterID: "cht_builtin_issue_to_pr", title: "Issue → PR → Test", bossSessionID: props.sessionID },
      })
      if (res.data) setSelectedRunID(res.data.id)
      await loadRuns()
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
      await props.sdk.client.workflowRun.entity.add({ path: { id }, body: { title } })
      setNewIssue("")
    } catch (err) {
      showToast({ type: "error", title: "Add failed", description: err instanceof Error ? err.message : "Unknown" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-13-regular text-text-base">
      <Show
        when={runs().length > 0}
        fallback={
          <div class="flex flex-col items-center gap-3 px-2 py-8 text-center text-text-weak">
            <span>No active workflow runs in this scope.</span>
            <Button size="small" variant="primary" disabled={busy()} onClick={createRun}>
              Start Issue → PR → Test run
            </Button>
          </div>
        }
      >
        {/* Run selector */}
        <div class="flex items-center gap-2">
          <span class="text-12-medium text-text-weak">Run</span>
          <select
            class="flex-1 rounded-md border border-border-weak bg-surface-raised-base px-2 py-1 text-13-regular"
            value={selectedRunID() ?? ""}
            onChange={(e) => setSelectedRunID(e.currentTarget.value)}
          >
            <For each={runs()}>
              {(r) => (
                <option value={r.id}>
                  {r.title} ({r.status})
                </option>
              )}
            </For>
          </select>
        </div>

        <Show when={run()}>
          {(r) => (
            <>
              {/* Section 1: Gates */}
              <Show when={gates().length > 0}>
                <section class="rounded-lg border border-border-interactive-base bg-surface-interactive-subtle p-3">
                  <h3 class="mb-2 text-13-semibold text-text-strong">Decisions needed</h3>
                  <div class="flex flex-col gap-3">
                    <For each={gates()}>
                      {(gate) => (
                        <div class="rounded-md border border-border-weak bg-surface-raised-base p-2">
                          <div class="text-13-medium text-text-strong">{gate.gate}</div>
                          <Show when={gate.context}>
                            <pre class="mt-1 whitespace-pre-wrap text-12-regular text-text-weak">{gate.context}</pre>
                          </Show>
                          <div class="mt-2 flex flex-wrap gap-2">
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
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              {/* Run controls + enqueue */}
              <section class="flex flex-wrap items-center gap-2">
                <span class="text-12-regular text-text-weak">
                  {r().status} · budget {r().budget.used}/{r().budget.maxModelCalls || "∞"}
                </span>
                <div class="flex-1" />
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
                <Button size="small" variant="secondary" disabled={busy()} onClick={() => control("cancel")}>
                  Cancel
                </Button>
              </section>
              <section class="flex gap-2">
                <input
                  class="flex-1 rounded-md border border-border-weak bg-surface-raised-base px-2 py-1 text-13-regular"
                  placeholder="Enqueue an issue…"
                  value={newIssue()}
                  onInput={(e) => setNewIssue(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && addEntity()}
                />
                <Button size="small" variant="primary" disabled={busy() || !newIssue().trim()} onClick={addEntity}>
                  Add
                </Button>
              </section>

              {/* Section 2: Entity board */}
              <section class="flex flex-col gap-2">
                <h3 class="text-13-semibold text-text-strong">Entities</h3>
                <For each={board()}>
                  {(group) => (
                    <Show when={group.entities.length > 0}>
                      <div>
                        <div
                          class={`mb-1 text-12-medium ${group.state === "blocked" ? "text-text-error-base" : "text-text-weak"}`}
                        >
                          {group.state} ({group.entities.length})
                        </div>
                        <div class="flex flex-col gap-1">
                          <For each={group.entities}>{(entity) => <EntityCard entity={entity} />}</For>
                        </div>
                      </div>
                    </Show>
                  )}
                </For>
              </section>

              {/* Section 3: Seats */}
              <section class="flex flex-col gap-1">
                <h3 class="text-13-semibold text-text-strong">Seats</h3>
                <For each={r().seats}>
                  {(seat) => (
                    <div class="flex items-center gap-2 text-12-regular">
                      <span
                        class={`inline-block h-2 w-2 rounded-full ${seat.status === "working" ? "bg-icon-success-base" : seat.status === "waiting" ? "bg-icon-warning-base" : "bg-border-weak"}`}
                      />
                      <span class="text-text-base">
                        {seat.seat}#{seat.instance}
                      </span>
                      <span class="text-text-weak">{seat.status}</span>
                      <Show when={seat.entityID}>
                        <span class="text-text-weak">→ {seat.entityID}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </section>

              {/* Section 4: Timeline */}
              <section class="flex flex-col gap-1">
                <h3 class="text-13-semibold text-text-strong">Timeline</h3>
                <div class="flex flex-col gap-0.5">
                  <For each={[...events()].reverse().slice(0, 60)}>
                    {(event) => {
                      const tone = BossData.eventTone(event.kind)
                      return (
                        <div
                          class={`text-12-regular ${tone === "error" ? "text-text-error-base" : tone === "warn" ? "text-text-warning-base" : "text-text-weak"}`}
                        >
                          {BossData.eventLabel(event)}
                        </div>
                      )
                    }}
                  </For>
                </div>
              </section>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}

function EntityCard(props: { entity: WorkflowEntity }) {
  return (
    <div class="rounded-md border border-border-weak bg-surface-raised-base px-2 py-1">
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-13-regular text-text-strong">{props.entity.title}</span>
        <Show when={props.entity.assignedSeat}>
          {(seat) => (
            <span class="shrink-0 text-11-regular text-text-weak">
              {seat().seat}#{seat().instance}
            </span>
          )}
        </Show>
      </div>
      <Show when={props.entity.blockedReason}>
        <div class="mt-0.5 text-11-regular text-text-error-base">{props.entity.blockedReason}</div>
      </Show>
      <Show when={props.entity.bindings?.prNumber}>
        <div class="mt-0.5 text-11-regular text-text-weak">PR {props.entity.bindings?.prNumber}</div>
      </Show>
    </div>
  )
}
