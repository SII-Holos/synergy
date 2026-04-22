import { Show, createMemo } from "solid-js"
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

export function StatsSection() {
  const { data, refresh } = useStats()

  return (
    <Show
      when={data()}
      fallback={
        <div class="flex items-center justify-center py-12">
          <button type="button" class="text-12-medium text-text-interactive-base hover:underline" onClick={refresh}>
            Load usage stats
          </button>
        </div>
      }
    >
      {(snapshot) => <StatsContent snapshot={snapshot()} />}
    </Show>
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
      <ActivityHeatmap days={snapshot().timeSeries.days} />
      <Milestones snapshot={snapshot()} />
    </div>
  )
}
