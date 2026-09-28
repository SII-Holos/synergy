import { Usage } from "@ericsanchezok/synergy-harness/usage"
import { RolloutAccounting } from "@ericsanchezok/synergy-harness/session/rollout/accounting"
import type { StatsSnapshot, DailyBucket } from "./types"

export namespace CanonicalStats {
  function projection(accounting: RolloutAccounting.Summary) {
    return {
      ...RolloutAccounting.project(accounting),
      cost: accounting.apiEstimate.known + accounting.legacy.cost,
      accounting,
    }
  }
  export async function apply(snapshot: StatsSnapshot): Promise<StatsSnapshot> {
    const usage = await Usage.summary()
    const days = new Map<string, DailyBucket>(
      snapshot.timeSeries.days.map((day) => [
        day.day,
        {
          ...day,
          ...projection(RolloutAccounting.empty()),
          toolCalls: 0,
        },
      ]),
    )
    for (const day of usage.daily)
      days.set(day.date, {
        day: day.date,
        sessions: 0,
        turns: 0,
        additions: 0,
        deletions: 0,
        files: 0,
        errors: 0,
        ...days.get(day.date),
        ...projection(day.accounting),
        toolCalls: day.toolCalls,
      })
    const total = projection(usage.accounting)
    const turns = snapshot.overview.totalTurns
    const activeDays = usage.daily.filter((day) => day.accounting.calls || day.accounting.legacy.messages).length || 1
    return {
      ...snapshot,
      tokenCost: {
        ...total,
        cacheHitRate: usage.cache.ratio ?? usage.cache.observedRatio ?? 0,
        avgCostPerTurn: turns ? total.cost / turns : 0,
        avgTokensPerTurn: turns ? usage.accounting.tokens.total.known / turns : 0,
        dailyCost: total.cost / activeDays,
        dailyTokens: usage.accounting.tokens.total.known / activeDays,
      },
      models: {
        models: usage.models.map((model) => {
          const previous = snapshot.models.models.find(
            (value) => value.providerID === model.providerID && value.modelID === model.modelID,
          )
          return {
            providerID: model.providerID,
            modelID: model.modelID,
            messages: previous?.messages ?? 0,
            turns: previous?.turns ?? 0,
            avgResponseMs: previous?.avgResponseMs ?? 0,
            ...projection(model.accounting),
          }
        }),
      },
      agents: {
        ...snapshot.agents,
        agents: Object.entries(usage.agents).map(([agent, accounting]) => {
          const previous = snapshot.agents.agents.find((value) => value.agent === agent)
          return {
            agent,
            messages: previous?.messages ?? 0,
            sessions: previous?.sessions ?? 0,
            subagentInvocations: previous?.subagentInvocations ?? 0,
            ...projection(accounting),
          }
        }),
      },
      tools: {
        tools: usage.tools.map((tool) => ({
          tool: tool.tool,
          calls: tool.calls,
          successes: tool.completed,
          errors: tool.failed,
          avgDurationMs: tool.averageMs ?? 0,
        })),
      },
      timeSeries: { ...snapshot.timeSeries, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) },
    }
  }
}
