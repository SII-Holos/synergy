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
    <div class="mb-4">
      <div class="library-sync-row library-sync-row-compact">
        <Show when={props.syncing || props.syncError}>
          <div class="library-toolbar-left">
            <span class="library-toolbar-summary">
              {props.syncing
                ? (props.progress?.message ?? phaseLabel(props.progress?.phase ?? "scan"))
                : (props.syncError ?? "")}
            </span>
            <Show when={props.syncing && props.progress}>
              {(progress) => (
                <span class="library-toolbar-summary">
                  {phaseLabel(progress().phase)} · {progress().current}/{progress().total}
                </span>
              )}
            </Show>
          </div>
        </Show>

        <button
          type="button"
          class="library-action-button shrink-0 disabled:cursor-default disabled:opacity-60"
          disabled={props.syncing}
          onClick={() => void props.onSync()}
        >
          {props.syncing ? "Syncing…" : "Sync stats"}
        </button>
      </div>

      <Show when={props.syncing && props.progress}>
        <div class="library-sync-progress">
          <div
            class="h-full rounded-full bg-text-strong/60 transition-[width] duration-300"
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
    <div class="flex flex-col gap-5 pb-5">
      <OverviewCards
        metrics={overviewMetrics()}
        streak={{
          current: snapshot().overview.currentStreak,
          longest: snapshot().overview.longestStreak,
        }}
      />
      <DailyTrend days={snapshot().timeSeries.days} />
      <ActivityHeatmap
        days={snapshot().timeSeries.days}
        hours={
          (snapshot().timeSeries as StatsSnapshot["timeSeries"] & { hours?: Array<{ hour: string; turns: number }> })
            .hours
        }
      />
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
      <Milestones snapshot={snapshot()} />
    </div>
  )
}
