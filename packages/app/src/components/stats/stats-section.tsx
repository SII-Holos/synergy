import { createMemo, Show } from "solid-js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { useStats } from "./use-stats"
import { OverviewCards } from "./overview-cards"
import { DailyTrend } from "./daily-trend"
import { TokenRing } from "./token-ring"
import { RankList } from "./rank-list"
import { CodeSummary } from "./code-summary"
import { ActivityHeatmap } from "./hourly-heatmap"
import { Milestones } from "./milestones"
import {
  buildOverviewMetrics,
  buildModelRows,
  buildAgentRows,
  buildToolRows,
  MODEL_METRICS,
  AGENT_METRICS,
  TOOL_METRICS,
} from "./model"

function progressPercent(current: number, total: number) {
  if (total <= 0) return 0
  return Math.max(4, Math.min(100, Math.round((current / total) * 100)))
}

function phaseLabel(phase: "scan" | "digest" | "bucket" | "snapshot") {
  if (phase === "scan") return "Scanning sessions"
  if (phase === "digest") return "Digesting activity"
  if (phase === "bucket") return "Updating buckets"
  return "Computing snapshot"
}

function StatsSyncBar(props: {
  syncing: boolean
  progress: {
    phase: "scan" | "digest" | "bucket" | "snapshot"
    current: number
    total: number
    message?: string
  } | null
  syncError: string | null
  onSync: () => void | Promise<void>
}) {
  const percent = createMemo(() => {
    const progress = props.progress
    if (!progress) return 0
    return progressPercent(progress.current, progress.total)
  })

  return (
    <div class="mb-4 rounded-[1.15rem] bg-surface-inset-base/42 p-3 ring-1 ring-inset ring-border-base/45 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker">Usage Stats</div>
          <div class="mt-1 text-13-medium text-text-base">
            {props.syncing
              ? (props.progress?.message ?? phaseLabel(props.progress?.phase ?? "scan"))
              : (props.syncError ?? "Sync usage stats manually when you want a fresh rollup.")}
          </div>
          <Show when={props.syncing && props.progress}>
            {(progress) => (
              <div class="mt-1 text-[10px] font-medium text-text-weak">
                {phaseLabel(progress().phase)} · {progress().current}/{progress().total}
              </div>
            )}
          </Show>
        </div>

        <button
          type="button"
          class="rounded-full bg-surface-raised-stronger-non-alpha px-3 py-1.5 text-12-medium text-text-interactive-base ring-1 ring-inset ring-border-base/50 transition hover:bg-surface-raised-base-hover hover:text-text-interactive-hover disabled:cursor-default disabled:opacity-60"
          disabled={props.syncing}
          onClick={() => void props.onSync()}
        >
          {props.syncing ? "Syncing…" : "Sync stats"}
        </button>
      </div>

      <Show when={props.syncing && props.progress}>
        <div class="mt-3 h-2 rounded-full bg-surface-base/70 p-0.5 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
          <div
            class="h-full rounded-full bg-[linear-gradient(90deg,rgba(62,122,98,0.92),rgba(84,162,134,0.88),rgba(136,198,170,0.82))] transition-[width] duration-300"
            style={{ width: `${percent()}%` }}
          />
        </div>
      </Show>
    </div>
  )
}

export function StatsSection() {
  const { data, error, loading, refresh, sync, syncing, progress, syncError } = useStats()

  return (
    <div>
      <StatsSyncBar syncing={syncing()} progress={progress()} syncError={syncError()} onSync={sync} />
      <Show
        when={data()}
        fallback={
          <div class="flex items-center justify-center py-12">
            <div class="flex max-w-sm flex-col items-center gap-2 text-center">
              <div class="text-12-medium text-text-base">
                {loading ? "Loading usage stats…" : "Usage stats are unavailable right now"}
              </div>
              <Show when={error() && !loading}>
                <div class="text-11-regular text-text-weak">{error()}</div>
              </Show>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-full bg-surface-inset-base/70 px-3 py-1.5 text-12-medium text-text-interactive-base transition hover:bg-surface-inset-base hover:text-text-interactive-hover"
                  onClick={refresh}
                >
                  {loading ? "Loading…" : "Retry loading stats"}
                </button>
                <button
                  type="button"
                  class="rounded-full bg-surface-raised-stronger-non-alpha px-3 py-1.5 text-12-medium text-text-interactive-base ring-1 ring-inset ring-border-base/50 transition hover:bg-surface-raised-base-hover hover:text-text-interactive-hover disabled:cursor-default disabled:opacity-60"
                  disabled={syncing()}
                  onClick={() => void sync()}
                >
                  {syncing() ? "Syncing…" : "Sync stats"}
                </button>
              </div>
            </div>
          </div>
        }
      >
        {(snapshot) => <StatsContent snapshot={snapshot()} />}
      </Show>
    </div>
  )
}

function StatsContent(props: { snapshot: StatsSnapshot }) {
  const snapshot = () => props.snapshot
  const overviewMetrics = createMemo(() => buildOverviewMetrics(snapshot()))
  const modelRows = createMemo(() => buildModelRows(snapshot()))
  const agentRows = createMemo(() => buildAgentRows(snapshot()))
  const toolRows = createMemo(() => buildToolRows(snapshot()))

  return (
    <div class="flex flex-col gap-0 pb-5">
      <OverviewCards
        metrics={overviewMetrics()}
        streak={{
          current: snapshot().overview.currentStreak,
          longest: snapshot().overview.longestStreak,
        }}
      />
      <DailyTrend days={snapshot().timeSeries.days} />
      <TokenRing tokens={snapshot().tokenCost.tokens} cacheHitRate={snapshot().tokenCost.cacheHitRate} />

      <RankList
        title="Models"
        description="Compare which models you rely on most by calls, token volume, or spend."
        metrics={MODEL_METRICS}
        rows={modelRows()}
        defaultMetric="messages"
      />

      <RankList
        title="Agents"
        description="See which agents carry the workload, cover the most sessions, or spend the most budget."
        metrics={AGENT_METRICS}
        rows={agentRows()}
        defaultMetric="messages"
      />

      <RankList
        title="Tools"
        description="Switch between usage, latency, and reliability to understand your working rhythm."
        metrics={TOOL_METRICS}
        rows={toolRows()}
        defaultMetric="calls"
      />

      <CodeSummary codeChanges={snapshot().codeChanges} />
      <ActivityHeatmap
        days={snapshot().timeSeries.days}
        hours={
          (snapshot().timeSeries as StatsSnapshot["timeSeries"] & { hours?: Array<{ hour: string; turns: number }> })
            .hours
        }
      />
      <Milestones snapshot={snapshot()} />
    </div>
  )
}
