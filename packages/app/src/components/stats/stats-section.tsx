import { Show, Switch, Match } from "solid-js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { useStats, formatCost } from "./use-stats"
import { OverviewCards } from "./overview-cards"
import { DailyTrend } from "./daily-trend"
import { TokenRing } from "./token-ring"
import { RankList } from "./rank-list"
import { CodeSummary } from "./code-summary"
import { HourlyHeatmap } from "./hourly-heatmap"
import { Milestones } from "./milestones"

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
      {(snapshot) => <StatsContent snapshot={snapshot()} onRefresh={refresh} />}
    </Show>
  )
}

function StatsContent(props: { snapshot: StatsSnapshot; onRefresh: () => void }) {
  const s = () => props.snapshot

  return (
    <div class="flex flex-col gap-0 pb-4">
      <OverviewCards overview={s().overview} tokenCost={s().tokenCost} />
      <DailyTrend days={s().timeSeries.days} />
      <TokenRing tokens={s().tokenCost.tokens} cacheHitRate={s().tokenCost.cacheHitRate} />

      <RankList
        title="Models"
        icon="🤖"
        items={s().models.models.map((m) => ({
          id: `${m.providerID}/${m.modelID}`,
          label: m.modelID,
          value: m.messages,
          detail: formatCost(m.cost),
          sublabel: m.providerID,
        }))}
      />

      <RankList
        title="Agents"
        icon="⚡"
        items={s().agents.agents.map((a) => ({
          id: a.agent,
          label: a.agent,
          value: a.messages,
          detail: formatCost(a.cost),
          sublabel: `${a.sessions} sessions`,
        }))}
      />

      <RankList
        title="Tools"
        icon="🔧"
        items={s().tools.tools.map((t) => ({
          id: t.tool,
          label: t.tool,
          value: t.calls,
          detail: t.calls > 0 ? `${Math.round((t.successes / t.calls) * 100)}%ok` : "—",
          sublabel: t.calls > 0 ? `${Math.round(t.avgDurationMs)}ms avg` : undefined,
        }))}
      />

      <CodeSummary codeChanges={s().codeChanges} />
      <HourlyHeatmap hourlyActivity={s().timeSeries.hourlyActivity} />
      <Milestones snapshot={s()} />
    </div>
  )
}
