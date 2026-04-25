import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { formatCompact, formatCost } from "./use-stats"

export type OverviewMetric = {
  id: string
  label: string
  value: string
  hint?: string
}

export type RankingMetric = {
  id: string
  label: string
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
  { id: "messages", label: "Calls", unit: "calls", color: "indigo" },
  { id: "tokens", label: "Tokens", unit: "tokens", color: "emerald" },
  { id: "cost", label: "Cost", unit: "usd", color: "amber" },
]

export const AGENT_METRICS: RankingMetric[] = [
  { id: "messages", label: "Messages", unit: "messages", color: "indigo" },
  { id: "sessions", label: "Sessions", unit: "sessions", color: "emerald" },
  { id: "cost", label: "Cost", unit: "usd", color: "amber" },
]

export const TOOL_METRICS: RankingMetric[] = [
  { id: "calls", label: "Calls", unit: "calls", color: "indigo" },
  { id: "duration", label: "Latency", unit: "ms", color: "amber" },
  { id: "success", label: "Success", unit: "%", color: "emerald" },
]

export function totalTokenValue(snapshot: StatsSnapshot): number {
  const tokens = snapshot.tokenCost.tokens
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function buildOverviewMetrics(snapshot: StatsSnapshot): OverviewMetric[] {
  return [
    {
      id: "sessions",
      label: "Sessions",
      value: formatCompact(snapshot.overview.totalSessions),
      hint: `${snapshot.overview.activeSessions} active · ${snapshot.overview.archivedSessions} archived`,
    },
    {
      id: "turns",
      label: "Turns",
      value: formatCompact(snapshot.overview.totalTurns),
      hint: `${formatCompact(snapshot.overview.totalMessages)} total messages`,
    },
    {
      id: "cost",
      label: "Cost",
      value: formatCost(snapshot.tokenCost.cost),
      hint: `${formatCost(snapshot.tokenCost.dailyCost)}/day`,
    },
    {
      id: "tokens",
      label: "Tokens",
      value: formatCompact(totalTokenValue(snapshot)),
      hint: `${Math.round(snapshot.tokenCost.cacheHitRate * 100)}% prompt cache reuse`,
    },
    {
      id: "lines",
      label: "Lines Added",
      value: formatCompact(snapshot.codeChanges.totalAdditions),
      hint: `${formatCompact(snapshot.codeChanges.netLines)} net`,
    },
    {
      id: "projects",
      label: "Projects",
      value: snapshot.overview.projectCount.toString(),
      hint: `${snapshot.overview.totalDays} active days`,
    },
  ]
}

export function buildModelRows(snapshot: StatsSnapshot): RankingRow[] {
  return snapshot.models.models.map((item) => {
    const tokens =
      item.tokens.input + item.tokens.output + item.tokens.reasoning + item.tokens.cache.read + item.tokens.cache.write
    return {
      id: `${item.providerID}/${item.modelID}`,
      label: item.modelID,
      primary: item.providerID,
      secondary: `${Math.round(item.avgResponseMs)}ms avg`,
      values: {
        messages: item.messages,
        tokens,
        cost: item.cost,
      },
    }
  })
}

export function buildAgentRows(snapshot: StatsSnapshot): RankingRow[] {
  return snapshot.agents.agents.map((item) => ({
    id: item.agent,
    label: item.agent,
    primary: `${item.subagentInvocations} delegated runs`,
    secondary: `${item.sessions} sessions covered`,
    values: {
      messages: item.messages,
      sessions: item.sessions,
      cost: item.cost,
    },
  }))
}

export function buildToolRows(snapshot: StatsSnapshot): RankingRow[] {
  return snapshot.tools.tools.map((item) => ({
    id: item.tool,
    label: item.tool,
    primary: `${item.calls.toLocaleString()} calls`,
    secondary: `${Math.round(item.avgDurationMs)}ms avg · ${item.calls > 0 ? Math.round((item.successes / item.calls) * 100) : 0}% success`,
    values: {
      calls: item.calls,
      duration: item.avgDurationMs,
      success: item.calls > 0 ? (item.successes / item.calls) * 100 : 0,
    },
  }))
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
    const monthLabel = monthAnchor ? monthAnchor.toLocaleString("en-US", { month: "short" }) : undefined

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
          dateLabel: `${day} · ${value.toLocaleString()} turns`,
        }
      }),
    })
  }

  return weeks
}

export function buildCalendarWeeks(snapshot: StatsSnapshot, limitDays?: number): CalendarWeek[] {
  return buildCalendarWeeksFromDays(snapshot.timeSeries.days, limitDays)
}
