import { createEffect, createMemo, Show } from "solid-js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { useStats } from "./use-stats"
import { useLocale } from "@/context/locale"
import { S } from "./stats-i18n"
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

function phaseLabel(phase: "scan" | "digest" | "bucket" | "snapshot", i18n: ReturnType<typeof useLocale>["i18n"]) {
  if (phase === "scan") return i18n._(S.phaseScanning.id)
  if (phase === "digest") return i18n._(S.phaseDigesting.id)
  if (phase === "bucket") return i18n._(S.phaseBucketing.id)
  return i18n._(S.phaseSnapshot.id)
}

export type WorkspaceStatsSyncHandle = {
  sync: () => void | Promise<void>
  syncing: () => boolean
  error: () => string | null
}

function StatsSyncStatus(props: {
  syncing: boolean
  progress: {
    phase: "scan" | "digest" | "bucket" | "snapshot"
    current: number
    total: number
    message?: string
  } | null
  syncError: string | null
  i18n: ReturnType<typeof useLocale>["i18n"]
}) {
  const percent = createMemo(() => {
    const progress = props.progress
    if (!progress) return 0
    return progressPercent(progress.current, progress.total)
  })

  return (
    <Show when={props.syncing || props.syncError}>
      <div class="mb-4">
        <div class="library-sync-row library-sync-row-compact">
          <div class="library-toolbar-left">
            <span class="library-toolbar-summary">
              {props.syncing
                ? (props.progress?.message ?? phaseLabel(props.progress?.phase ?? "scan", props.i18n))
                : (props.syncError ?? "")}
            </span>
            <Show when={props.syncing && props.progress}>
              {(progress) => (
                <span class="library-toolbar-summary">
                  {phaseLabel(progress().phase, props.i18n)} · {progress().current}/{progress().total}
                </span>
              )}
            </Show>
          </div>
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
    </Show>
  )
}

export function StatsSection(props: { registerSync?: (handle: WorkspaceStatsSyncHandle) => void }) {
  const { data, error, loading, refresh, sync, syncing, progress, syncError } = useStats()
  const { i18n, fmt } = useLocale()

  createEffect(() => {
    props.registerSync?.({
      sync,
      syncing,
      error: syncError,
    })
  })

  return (
    <div>
      <StatsSyncStatus syncing={syncing()} progress={progress()} syncError={syncError()} i18n={i18n} />
      <Show
        when={data()}
        fallback={
          <div class="flex items-center justify-center py-12">
            <div class="flex max-w-sm flex-col items-center gap-2 text-center">
              <div class="text-12-medium text-text-base">
                {loading ? i18n._(S.loadLoading.id) : i18n._(S.loadUnavailable.id)}
              </div>
              <Show when={error() && !loading}>
                <div class="text-11-regular text-text-weak">{error()}</div>
              </Show>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-full bg-surface-inset-base/70 px-3 py-1.5 text-12-medium text-text-interactive-base transition hover:bg-surface-inset-base hover:text-text-interactive-base"
                  onClick={refresh}
                >
                  {loading ? i18n._(S.loadButtonLoading.id) : i18n._(S.loadButtonRetry.id)}
                </button>
              </div>
            </div>
          </div>
        }
      >
        {(snapshot) => <StatsContent snapshot={snapshot()} i18n={i18n} fmt={fmt} />}
      </Show>
    </div>
  )
}

function StatsContent(props: {
  snapshot: StatsSnapshot
  i18n: ReturnType<typeof useLocale>["i18n"]
  fmt: ReturnType<typeof useLocale>["fmt"]
}) {
  const { i18n, fmt } = props
  const snapshot = () => props.snapshot
  const overviewMetrics = createMemo(() => buildOverviewMetrics(snapshot(), i18n))
  const modelRows = createMemo(() => buildModelRows(snapshot(), i18n))
  const agentRows = createMemo(() => buildAgentRows(snapshot(), i18n))
  const toolRows = createMemo(() => buildToolRows(snapshot(), fmt.number, i18n))

  return (
    <div class="library-stats-content flex flex-col gap-5 pb-5">
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
        title={i18n._(S.rankTitleModels.id)}
        description={i18n._(S.rankDescModels.id)}
        metrics={MODEL_METRICS}
        rows={modelRows()}
        defaultMetric="messages"
      />

      <RankList
        title={i18n._(S.rankTitleAgents.id)}
        description={i18n._(S.rankDescAgents.id)}
        metrics={AGENT_METRICS}
        rows={agentRows()}
        defaultMetric="messages"
      />

      <RankList
        title={i18n._(S.rankTitleTools.id)}
        description={i18n._(S.rankDescTools.id)}
        metrics={TOOL_METRICS}
        rows={toolRows()}
        defaultMetric="calls"
      />

      <CodeSummary codeChanges={snapshot().codeChanges} />
      <Milestones snapshot={snapshot()} />
    </div>
  )
}
