import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionSummary, ExecutionTrajectoryNode } from "@ericsanchezok/synergy-sdk/client"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { VList } from "virtua/solid"
import { E, K } from "./i18n"

function bins(lane: ExecutionSummary["lanes"][number], total: number, time?: { start: number; end: number }) {
  const result = new Map<
    number,
    { key: number; node: ExecutionTrajectoryNode; count: number; start: number; end: number }
  >()
  for (const node of lane.nodes) {
    const index = node.activity?.index ?? 0
    const position = time
      ? (node.started - time.start) / Math.max(1, time.end - time.start)
      : index / Math.max(1, total)
    const key = Math.max(0, Math.min(23, Math.floor(position * 24)))
    const old = result.get(key)
    result.set(key, {
      key,
      node: old?.node ?? node,
      count: (old?.count ?? 0) + (node.activity?.count ?? 1),
      start: Math.min(old?.start ?? index, index),
      end: Math.max(old?.end ?? index, node.activity?.endIndex ?? index),
    })
  }
  return [...result.values()].sort((a, b) => a.key - b.key)
}

export function ActivityExplorer(props: { summary: ExecutionSummary; onLocate: (id: string) => void }) {
  const { _, i18n } = useLingui()
  const sdk = useSDK()
  const dialog = useDialog()
  const [scale, setScale] = createSignal<"order" | "time">("order")
  const [records, setRecords] = createSignal<ExecutionTrajectoryNode[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [cursor, setCursor] = createSignal<string | undefined>()
  let selected: { start: number; end: number; kind: "input" | "model" | "tool" } | undefined
  let abort: AbortController | undefined
  let generation = 0
  onCleanup(() => abort?.abort())
  const load = async (next?: string) => {
    if (!selected) return
    abort?.abort()
    abort = new AbortController()
    const version = ++generation
    setLoading(true)
    setError(false)
    try {
      const response = await sdk.client.session.executionTrajectory(
        {
          sessionID: props.summary.sessionID,
          runID: props.summary.runID,
          actor: "all",
          mode: "records",
          activityFrom: selected.start,
          activityTo: selected.end,
          kinds:
            selected.kind === "input" ? "input,subtask" : selected.kind === "model" ? "model,retry,compaction" : "tool",
          cursor: next,
          limit: 100,
        },
        { signal: abort.signal, throwOnError: true },
      )
      if (generation !== version) return
      setRecords(response.data.items)
      setCursor(response.data.nextCursor ?? undefined)
    } catch {
      if (!abort.signal.aborted && generation === version) setError(true)
    } finally {
      if (generation === version) setLoading(false)
    }
  }
  const start = () => props.summary.lanes[0]?.start ?? props.summary.computedAt
  const end = () => props.summary.lanes[0]?.end ?? start() + 1
  const roundName = (segment: NonNullable<ExecutionSummary["activitySegments"]>[number]) => {
    if (segment.rounds > 1) return _({ ...E.multipleRounds, values: { count: segment.rounds } })
    const index = props.summary.rounds.findIndex((round) => round.id === segment.runID)
    return index < 0 ? _(E.unassigned) : _({ ...E.round, values: { number: index + 1 } })
  }
  const gaps = createMemo(() => {
    const nodes = props.summary.lanes.flatMap((lane) => lane.nodes).toSorted((a, b) => a.started - b.started)
    const result: Array<{ start: number; end: number }> = []
    let ended = start()
    for (const node of nodes) {
      if (node.started - ended > 60_000) result.push({ start: ended, end: node.started })
      ended = Math.max(ended, node.ended ?? node.started)
    }
    return result
  })
  const tick = (index: number) =>
    scale() === "order"
      ? String(Math.round((index / 4) * Math.max(1, props.summary.activityTotal)))
      : new Intl.DateTimeFormat(i18n().locale, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(start() + ((end() - start()) * index) / 4)
  return (
    <Dialog title={_(E.activity)} size="wide" class="execution-activity-dialog">
      <div class="execution-chart-controls" role="group" aria-label={_(E.view)}>
        <button type="button" aria-pressed={scale() === "order"} onClick={() => setScale("order")}>
          {_(E.activityOrder)}
        </button>
        <button type="button" aria-pressed={scale() === "time"} onClick={() => setScale("time")}>
          {_(E.realTime)}
        </button>
      </div>
      <p class="execution-help">
        {_({ ...E.humanInputs, values: { count: props.summary.humanInputs } })} ·{" "}
        {_({ ...E.taskInstructions, values: { count: props.summary.taskInstructions } })}
      </p>
      <Show
        when={scale() === "time" && props.summary.lanes.some((lane) => lane.nodes.some((node) => node.started <= 0))}
      >
        <p class="execution-help">{_(E.missingTimes)}</p>
      </Show>
      <div class="execution-chart-scroll">
        <div class="execution-chart-grid">
          <Show when={scale() === "order"}>
            <div class="execution-chart-segments" aria-label={_(E.rounds)}>
              <For each={props.summary.activitySegments ?? []}>
                {(segment) => (
                  <span
                    title={roundName(segment)}
                    style={{
                      left: (segment.from / Math.max(1, props.summary.activityTotal)) * 100 + "%",
                      width:
                        (Math.max(1, segment.to - segment.from + 1) / Math.max(1, props.summary.activityTotal)) * 100 +
                        "%",
                    }}
                  >
                    {roundName(segment)}
                  </span>
                )}
              </For>
            </div>
          </Show>
          <For each={props.summary.lanes}>
            {(lane) => (
              <div class="execution-chart-lane">
                <span>{_(K[lane.kind])}</span>
                <div
                  class="execution-chart-track"
                  role="group"
                  aria-label={_(K[lane.kind])}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
                    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")]
                    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? buttons.length - 1
                          : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)))
                    event.preventDefault()
                    buttons[next]?.focus()
                  }}
                >
                  <Show when={scale() === "time"}>
                    <For each={gaps()}>
                      {(gap) => (
                        <span
                          class="execution-chart-idle"
                          style={{
                            left: ((gap.start - start()) / Math.max(1, end() - start())) * 100 + "%",
                            width: ((gap.end - gap.start) / Math.max(1, end() - start())) * 100 + "%",
                          }}
                          title={_({
                            ...E.idle,
                            values: { duration: Math.round((gap.end - gap.start) / 60_000) + "m" },
                          })}
                        />
                      )}
                    </For>
                  </Show>
                  <For
                    each={bins(
                      lane,
                      props.summary.activityTotal,
                      scale() === "time" ? { start: start(), end: end() } : undefined,
                    )}
                  >
                    {(group) => (
                      <button
                        type="button"
                        class="execution-chart-target"
                        data-kind={lane.kind}
                        style={{ left: (group.key / 24) * 100 + "%" }}
                        aria-label={_({
                          ...E.chartEvents,
                          values: { count: group.count, start: group.start + 1, end: group.end + 1 },
                        })}
                        title={group.node.preview || group.node.title}
                        onClick={() => {
                          selected = { ...group, kind: lane.kind }
                          void load()
                        }}
                      >
                        {group.count > 1 ? group.count : ""}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
          <div class="execution-chart-axis">
            <For each={[0, 1, 2, 3, 4]}>{(index) => <span>{tick(index)}</span>}</For>
          </div>
        </div>
      </div>
      <Show when={loading()}>
        <p role="status" class="execution-help">
          {_(E.loading)}
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="execution-help">
          {_(E.error)}
        </p>
      </Show>
      <Show when={records().length}>
        <div class="execution-chart-members">
          <VList data={records()} itemSize={44} overscan={2} style={{ height: "240px" }}>
            {(node) => (
              <button
                type="button"
                onClick={() => {
                  dialog.close()
                  props.onLocate(node.id)
                }}
              >
                <span>{_(K[node.kind])}</span>
                <strong>{node.preview || node.title}</strong>
                <span data-state={node.status}>{_(E[node.status])}</span>
              </button>
            )}
          </VList>
        </div>
      </Show>
      <Show when={cursor()}>
        <button type="button" class="execution-page-link" disabled={loading()} onClick={() => void load(cursor())}>
          {_(E.next)}
        </button>
      </Show>
    </Dialog>
  )
}
