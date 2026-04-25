import { EngramDB } from "../database"
import type {
  EngramStatsSnapshot,
  EngramOverviewStats,
  MemoryDistributionStats,
  ExperienceRLStats,
  RewardDimensionStats,
  QValueDistribution,
  QHistogramBin,
  QTrendPoint,
  TopExperienceItem,
  RetrievalStats,
  ScopeStats,
  ScopeCount,
  EngramTimeSeriesStats,
  EngramDailyBucket,
} from "./types"

export namespace Rollup {
  const REWARD_DIMS = ["outcome", "intent", "execution", "orchestration", "expression"] as const

  const DEFAULT_REWARD_WEIGHTS = {
    outcome: 0.35,
    intent: 0.25,
    execution: 0.2,
    orchestration: 0.1,
    expression: 0.1,
  }

  function compositeQ(qValuesStr: string): number {
    const qv: Record<string, number> = JSON.parse(qValuesStr)
    return (
      (qv.outcome ?? 0) * DEFAULT_REWARD_WEIGHTS.outcome +
      (qv.intent ?? 0) * DEFAULT_REWARD_WEIGHTS.intent +
      (qv.execution ?? 0) * DEFAULT_REWARD_WEIGHTS.execution +
      (qv.orchestration ?? 0) * DEFAULT_REWARD_WEIGHTS.orchestration +
      (qv.expression ?? 0) * DEFAULT_REWARD_WEIGHTS.expression
    )
  }

  function dayKey(timestamp: number): string {
    const d = new Date(timestamp)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }

  /** Week key based on local timezone: "2026-W16" */
  function weekKey(timestamp: number): string {
    const d = new Date(timestamp)
    const dayNum = d.getDay() || 7
    d.setDate(d.getDate() + 4 - dayNum)
    const yearStart = new Date(d.getFullYear(), 0, 1)
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
    return `${d.getFullYear()}-W${String(weekNo).padStart(2, "0")}`
  }

  function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, idx)] ?? 0
  }

  function median(sorted: number[]): number {
    if (sorted.length === 0) return 0
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
  }

  function stddev(values: number[], avg: number): number {
    if (values.length < 2) return 0
    const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length
    return Math.sqrt(variance)
  }

  // -----------------------------------------------------------------------
  // Dimension 1 — Overview
  // -----------------------------------------------------------------------

  function computeOverview(): EngramOverviewStats {
    const memories = EngramDB.Memory.listAll()
    const experiences = EngramDB.Experience.listAll()
    const evaluated = experiences.filter((e) => e.reward_status === "evaluated")
    const failed = experiences.filter((e) => e.reward_status === "encoding_failed")
    const pending = experiences.filter((e) => e.reward_status === "pending")

    const scopeSet = new Set<string>()
    for (const e of experiences) scopeSet.add(e.scope_id)
    const scopeCount = (memories.length > 0 ? 1 : 0) + scopeSet.size

    const daySet = new Set<string>()
    for (const m of memories) daySet.add(dayKey(m.created_at))
    for (const e of experiences) daySet.add(dayKey(e.created_at))

    return {
      totalMemories: memories.length,
      totalExperiences: experiences.length,
      evaluationRate: experiences.length > 0 ? evaluated.length / experiences.length : 0,
      experiencesEvaluated: evaluated.length,
      experiencesFailed: failed.length,
      experiencesPending: pending.length,
      scopeCount,
      activeDays: daySet.size,
    }
  }

  // -----------------------------------------------------------------------
  // Dimension 2 — Memory Distribution
  // -----------------------------------------------------------------------

  function computeMemoryDistribution(): MemoryDistributionStats {
    const memories = EngramDB.Memory.listAll()

    const categoryMap = new Map<string, number>()
    const recallModeMap = new Map<string, number>()

    for (const m of memories) {
      categoryMap.set(m.category, (categoryMap.get(m.category) ?? 0) + 1)
      recallModeMap.set(m.recall_mode, (recallModeMap.get(m.recall_mode) ?? 0) + 1)
    }

    const byCategory = [...categoryMap.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)

    const byRecallMode = [...recallModeMap.entries()]
      .map(([recallMode, count]) => ({ recallMode, count }))
      .sort((a, b) => b.count - a.count)

    return { byCategory, byRecallMode }
  }

  // -----------------------------------------------------------------------
  // Dimension 3 — Experience RL & Q-Learning
  // -----------------------------------------------------------------------

  function computeExperienceRL(): ExperienceRLStats {
    const experiences = EngramDB.Experience.listAll()
    const evaluated = experiences.filter((e) => e.reward_status === "evaluated")

    // Per-dimension box-plot stats
    const rewardDimensions: RewardDimensionStats[] = REWARD_DIMS.map((dim) => {
      const values: number[] = []
      for (const e of evaluated) {
        const rewards: Record<string, number> = JSON.parse(e.rewards)
        if (rewards[dim] !== undefined) values.push(rewards[dim]!)
      }
      const avg = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0

      // Build value distribution (rewards are discrete: -1, 0, 1)
      const countMap = new Map<number, number>()
      for (const v of values) countMap.set(v, (countMap.get(v) ?? 0) + 1)
      const distribution = [...countMap.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value - b.value)

      return {
        dimension: dim,
        avg,
        std: stddev(values, avg),
        distribution,
      }
    })

    // Composite Q histogram (20 bins from -1 to 1)
    const compositeQs: number[] = []
    for (const e of evaluated) {
      compositeQs.push(compositeQ(e.q_values))
    }
    compositeQs.sort((a, b) => a - b)

    const BIN_COUNT = 20
    const BIN_WIDTH = 2 / BIN_COUNT
    const histogram: QHistogramBin[] = Array.from({ length: BIN_COUNT }, (_, i) => {
      const lower = -1 + i * BIN_WIDTH
      return { bin: lower.toFixed(2), count: 0 }
    })
    for (const q of compositeQs) {
      const idx = Math.min(Math.floor((q + 1) / BIN_WIDTH), BIN_COUNT - 1)
      histogram[idx]!.count++
    }

    // Q trend by week
    const weekMap = new Map<string, { qs: number[] }>()
    for (const e of evaluated) {
      const week = weekKey(e.created_at)
      const bucket = weekMap.get(week)
      if (bucket) {
        bucket.qs.push(compositeQ(e.q_values))
      } else {
        weekMap.set(week, { qs: [compositeQ(e.q_values)] })
      }
    }
    const trend: QTrendPoint[] = [...weekMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, data]) => {
        data.qs.sort((a, b) => a - b)
        return { period, medianQ: median(data.qs), count: data.qs.length }
      })

    const avgCompositeQ = compositeQs.length > 0 ? compositeQs.reduce((s, v) => s + v, 0) / compositeQs.length : 0

    const qDistribution: QValueDistribution = {
      histogram,
      trend,
      avgCompositeQ,
      medianCompositeQ: median(compositeQs),
      stdCompositeQ: stddev(compositeQs, avgCompositeQ),
    }

    // Visit stats
    const allVisits = experiences.map((e) => e.q_visits).sort((a, b) => a - b)

    return {
      rewardDimensions,
      qDistribution,
      avgVisits: allVisits.length > 0 ? allVisits.reduce((s, v) => s + v, 0) / allVisits.length : 0,
      medianVisits: median(allVisits),
      neverRetrieved: allVisits.filter((v) => v === 0).length,
      frequentlyRetrieved: allVisits.filter((v) => v >= 5).length,
    }
  }

  // -----------------------------------------------------------------------
  // Dimension 4 — Retrieval Activity
  // -----------------------------------------------------------------------

  function computeRetrieval(): RetrievalStats {
    const experiences = EngramDB.Experience.listAll()
    const evaluated = experiences.filter((e) => e.reward_status === "evaluated")

    const sorted = [...evaluated].sort((a, b) => b.q_visits - a.q_visits)
    const topExperiences: TopExperienceItem[] = sorted.slice(0, 10).map((e) => ({
      id: e.id,
      intent: e.intent.length > 80 ? e.intent.slice(0, 77) + "..." : e.intent,
      scopeID: e.scope_id,
      visits: e.q_visits,
      compositeQ: compositeQ(e.q_values),
    }))

    const buckets: Record<string, number> = { "0": 0, "1": 0, "2-4": 0, "5-9": 0, "10+": 0 }
    for (const e of experiences) {
      const v = e.q_visits
      if (v === 0) buckets["0"]!++
      else if (v === 1) buckets["1"]!++
      else if (v <= 4) buckets["2-4"]!++
      else if (v <= 9) buckets["5-9"]!++
      else buckets["10+"]!++
    }
    const visitsDistribution = Object.entries(buckets).map(([range, count]) => ({ range, count }))

    return { topExperiences, visitsDistribution }
  }

  // -----------------------------------------------------------------------
  // Dimension 5 — Scope Distribution
  // -----------------------------------------------------------------------

  function computeScopes(): ScopeStats {
    const experiences = EngramDB.Experience.listAll()
    const scopeMap = new Map<string, { memories: number; experiences: number; evaluated: number }>()

    const memoryCount = EngramDB.Memory.count()
    if (memoryCount > 0) {
      scopeMap.set("global", { memories: memoryCount, experiences: 0, evaluated: 0 })
    }

    for (const e of experiences) {
      const existing = scopeMap.get(e.scope_id)
      if (existing) {
        existing.experiences++
        if (e.reward_status === "evaluated") existing.evaluated++
      } else {
        scopeMap.set(e.scope_id, {
          memories: 0,
          experiences: 1,
          evaluated: e.reward_status === "evaluated" ? 1 : 0,
        })
      }
    }

    const scopes: ScopeCount[] = [...scopeMap.entries()]
      .map(([scopeID, counts]) => ({ scopeID, ...counts }))
      .sort((a, b) => b.experiences - a.experiences)

    return { scopes }
  }

  // -----------------------------------------------------------------------
  // Dimension 6 — Time Series
  // -----------------------------------------------------------------------

  function computeTimeSeries(): EngramTimeSeriesStats {
    const memories = EngramDB.Memory.listAll()
    const experiences = EngramDB.Experience.listAll()

    const dayMap = new Map<
      string,
      { memoriesCreated: number; experiencesCreated: number; evaluatedCreated: number; qSum: number; qCount: number }
    >()

    for (const m of memories) {
      const day = dayKey(m.created_at)
      const bucket = dayMap.get(day)
      if (bucket) {
        bucket.memoriesCreated++
      } else {
        dayMap.set(day, { memoriesCreated: 1, experiencesCreated: 0, evaluatedCreated: 0, qSum: 0, qCount: 0 })
      }
    }

    for (const e of experiences) {
      const day = dayKey(e.created_at)
      const bucket = dayMap.get(day)
      const isEvaluated = e.reward_status === "evaluated" ? 1 : 0
      const q = e.reward_status === "evaluated" ? compositeQ(e.q_values) : 0
      if (bucket) {
        bucket.experiencesCreated++
        bucket.evaluatedCreated += isEvaluated
        if (isEvaluated) {
          bucket.qSum += q
          bucket.qCount++
        }
      } else {
        dayMap.set(day, {
          memoriesCreated: 0,
          experiencesCreated: 1,
          evaluatedCreated: isEvaluated,
          qSum: q,
          qCount: isEvaluated,
        })
      }
    }

    const days: EngramDailyBucket[] = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, b]) => ({
        day,
        memoriesCreated: b.memoriesCreated,
        experiencesCreated: b.experiencesCreated,
        experiencesEvaluated: b.evaluatedCreated,
        avgCompositeQ: b.qCount > 0 ? b.qSum / b.qCount : 0,
      }))

    const hourlyActivity = new Array(24).fill(0) as number[]
    for (const e of experiences) {
      const hour = new Date(e.created_at).getHours()
      hourlyActivity[hour]++
    }

    return { days, hourlyActivity }
  }

  // -----------------------------------------------------------------------
  // Full snapshot
  // -----------------------------------------------------------------------

  export function snapshot(): EngramStatsSnapshot {
    return {
      overview: computeOverview(),
      memoryDistribution: computeMemoryDistribution(),
      experienceRL: computeExperienceRL(),
      retrieval: computeRetrieval(),
      scopes: computeScopes(),
      timeSeries: computeTimeSeries(),
      computedAt: Date.now(),
    }
  }
}
