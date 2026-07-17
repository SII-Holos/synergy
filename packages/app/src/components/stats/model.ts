import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { formatCompact, formatCost } from "./use-stats"
import { S } from "./stats-i18n"
import type { I18n } from "@lingui/core"
import type { MessageDescriptor } from "@lingui/core"

export type OverviewMetric = {
  id: string
  label: string
  value: string
  hint?: string
}

export type RankingMetric = {
  id: string
  label: MessageDescriptor
  unit: string
  color: "indigo" | "emerald" | "amber" | "rose"
}

export type RankingRow = {
  id: string
  label: string
  primary: string
  secondary?: string
  values: Record<string, number>
}

export type CalendarCell = {
  day: string
  level: 0 | 1 | 2 | 3 | 4
  value: number
  dateLabel: string
}

export type CalendarWeek = {
  monthLabel?: string
  cells: Array<CalendarCell | null>
}

export const MODEL_METRICS: RankingMetric[] = [
  { id: "messages", label: S.rankMetricCalls, unit: "calls", color: "indigo" },
  { id: "tokens", label: S.rankMetricTokens, unit: "tokens", color: "emerald" },
  { id: "cost", label: S.rankMetricCost, unit: "usd", color: "amber" },
]

export const AGENT_METRICS: RankingMetric[] = [
  { id: "messages", label: S.rankMetricMessages, unit: "messages", color: "indigo" },
  { id: "sessions", label: S.rankMetricSessions, unit: "sessions", color: "emerald" },
  { id: "cost", label: S.rankMetricCost, unit: "usd", color: "amber" },
]

export const TOOL_METRICS: RankingMetric[] = [
  { id: "calls", label: S.rankMetricCalls, unit: "calls", color: "indigo" },
  { id: "duration", label: S.rankMetricLatency, unit: "ms", color: "amber" },
  { id: "success", label: S.rankMetricSuccess, unit: "%", color: "emerald" },
]

export function totalTokenValue(snapshot: StatsSnapshot): number {
  const tokens = snapshot.tokenCost.tokens
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function buildOverviewMetrics(snapshot: StatsSnapshot, i18n: I18n): OverviewMetric[] {
  return [
    {
      id: "sessions",
      label: i18n._(S.overviewLabelSessions.id),
      value: formatCompact(snapshot.overview.totalSessions),
      hint: i18n._(S.overviewHintActive.id, {
        active: formatCompact(snapshot.overview.activeSessions),
        archived: formatCompact(snapshot.overview.archivedSessions),
      }),
    },
    {
      id: "turns",
      label: i18n._(S.overviewLabelTurns.id),
      value: formatCompact(snapshot.overview.totalTurns),
      hint: i18n._(S.overviewHintMessages.id, { count: formatCompact(snapshot.overview.totalMessages) }),
    },
    {
      id: "cost",
      label: i18n._(S.overviewLabelCost.id),
      value: formatCost(snapshot.tokenCost.cost),
      hint: i18n._(S.overviewHintCostPerDay.id, { cost: formatCost(snapshot.tokenCost.dailyCost) }),
    },
    {
      id: "tokens",
      label: i18n._(S.overviewLabelTokens.id),
      value: formatCompact(totalTokenValue(snapshot)),
      hint: i18n._(S.overviewHintCacheReuse.id, {
        pct: String(Math.round(snapshot.tokenCost.cacheHitRate * 100)),
      }),
    },
    {
      id: "lines",
      label: i18n._(S.overviewLabelLinesAdded.id),
      value: formatCompact(snapshot.codeChanges.totalAdditions),
      hint: i18n._(S.overviewHintNet.id, { count: formatCompact(snapshot.codeChanges.netLines) }),
    },
    {
      id: "projects",
      label: i18n._(S.overviewLabelProjects.id),
      value: snapshot.overview.projectCount.toString(),
      hint: i18n._(S.overviewHintActiveDays.id, { count: String(snapshot.overview.totalDays) }),
    },
  ]
}

export function buildModelRows(snapshot: StatsSnapshot, i18n: I18n): RankingRow[] {
  return snapshot.models.models.map((item) => {
    const tokens =
      item.tokens.input + item.tokens.output + item.tokens.reasoning + item.tokens.cache.read + item.tokens.cache.write
    return {
      id: `${item.providerID}/${item.modelID}`,
      label: item.modelID,
      primary: item.providerID,
      secondary: i18n._(S.modelAvgMs.id, { avg: String(Math.round(item.avgResponseMs)) }),
      values: {
        messages: item.messages,
        tokens,
        cost: item.cost,
      },
    }
  })
}

export function buildAgentRows(snapshot: StatsSnapshot, i18n: I18n): RankingRow[] {
  return snapshot.agents.agents.map((item) => ({
    id: item.agent,
    label: item.agent,
    primary: i18n._(S.agentDelegatedRuns.id, { count: String(item.subagentInvocations) }),
    secondary: i18n._(S.agentSessionsCovered.id, { count: String(item.sessions) }),
    values: {
      messages: item.messages,
      sessions: item.sessions,
      cost: item.cost,
    },
  }))
}

export function buildToolRows(snapshot: StatsSnapshot, fmt: (n: number) => string, i18n: I18n): RankingRow[] {
  return snapshot.tools.tools.map((item) => {
    const successPct = item.calls > 0 ? Math.round((item.successes / item.calls) * 100) : 0
    return {
      id: item.tool,
      label: item.tool,
      primary: i18n._(S.toolCallsPrimary.id, { calls: fmt(item.calls) }),
      secondary:
        successPct > 0
          ? i18n._(S.toolAvgSecondary.id, { avg: String(Math.round(item.avgDurationMs)), pct: String(successPct) })
          : i18n._(S.toolNoSuccessSecondary.id, { avg: String(Math.round(item.avgDurationMs)) }),
      values: {
        calls: item.calls,
        duration: item.avgDurationMs,
        success: item.calls > 0 ? (item.successes / item.calls) * 100 : 0,
      },
    }
  })
}

function startOfWeek(date: Date): Date {
  const copy = new Date(date)
  const day = copy.getDay()
  const diff = day === 0 ? -6 : 1 - day
  copy.setDate(copy.getDate() + diff)
  copy.setHours(0, 0, 0, 0)
  return copy
}

export function buildCalendarWeeksFromDays(
  sourceDays: StatsSnapshot["timeSeries"]["days"],
  dateFmt: (d: Date, opts?: Intl.DateTimeFormatOptions) => string,
  limitDays?: number,
): CalendarWeek[] {
  const days = limitDays && limitDays > 0 ? sourceDays.slice(-limitDays) : sourceDays
  if (days.length === 0) return []

  const byDay = new Map(days.map((day) => [day.day, day.turns]))
  const values = days.map((day) => day.turns)
  const max = Math.max(...values, 0)

  const firstDay = new Date(days[0]!.day)
  const lastDay = new Date(days[days.length - 1]!.day)
  const start = startOfWeek(firstDay)
  const end = new Date(lastDay)
  end.setHours(0, 0, 0, 0)

  const allDates: Date[] = []
  const cursor = new Date(start)
  while (cursor <= end) {
    allDates.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }

  const weeks: CalendarWeek[] = []
  for (let index = 0; index < allDates.length; index += 7) {
    const weekDates = allDates.slice(index, index + 7)
    const monthAnchor = weekDates.find((date) => date.getDate() <= 7)
    const monthLabel = monthAnchor ? dateFmt(monthAnchor, { month: "short" }) : undefined

    weeks.push({
      monthLabel,
      cells: weekDates.map((date) => {
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
        const value = byDay.get(day) ?? 0
        const ratio = max > 0 ? value / max : 0
        const level = value === 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4
        return {
          day,
          value,
          level: level as 0 | 1 | 2 | 3 | 4,
          dateLabel: `${day} · ${String(value)} turns`,
        }
      }),
    })
  }

  return weeks
}

export function buildCalendarWeeks(
  snapshot: StatsSnapshot,
  dateFmt: (d: Date, opts?: Intl.DateTimeFormatOptions) => string,
  limitDays?: number,
): CalendarWeek[] {
  return buildCalendarWeeksFromDays(snapshot.timeSeries.days, dateFmt, limitDays)
}
