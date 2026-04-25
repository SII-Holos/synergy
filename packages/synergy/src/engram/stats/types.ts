import z from "zod"

// ---------------------------------------------------------------------------
// Dimension 1 — Overview
// ---------------------------------------------------------------------------

export const EngramOverviewStats = z.object({
  totalMemories: z.number(),
  totalExperiences: z.number(),
  /** Evaluated / total ratio */
  evaluationRate: z.number(),
  /** Experiences with reward_status = 'evaluated' */
  experiencesEvaluated: z.number(),
  /** Experiences with reward_status = 'encoding_failed' */
  experiencesFailed: z.number(),
  /** Experiences with reward_status = 'pending' */
  experiencesPending: z.number(),
  /** Distinct scope IDs with at least one memory or experience */
  scopeCount: z.number(),
  /** Number of days with at least one memory or experience created */
  activeDays: z.number(),
})
export type EngramOverviewStats = z.infer<typeof EngramOverviewStats>

// ---------------------------------------------------------------------------
// Dimension 2 — Memory Category & RecallMode Distribution
// ---------------------------------------------------------------------------

export const MemoryCategoryCount = z.object({
  category: z.string(),
  count: z.number(),
})
export type MemoryCategoryCount = z.infer<typeof MemoryCategoryCount>

export const MemoryRecallModeCount = z.object({
  recallMode: z.string(),
  count: z.number(),
})
export type MemoryRecallModeCount = z.infer<typeof MemoryRecallModeCount>

export const MemoryDistributionStats = z.object({
  byCategory: z.array(MemoryCategoryCount),
  byRecallMode: z.array(MemoryRecallModeCount),
})
export type MemoryDistributionStats = z.infer<typeof MemoryDistributionStats>

// ---------------------------------------------------------------------------
// Dimension 3 — Experience Reward & Q-Learning
// ---------------------------------------------------------------------------

export const RewardDimensionStats = z.object({
  dimension: z.string(),
  avg: z.number(),
  std: z.number(),
  /** Value distribution for discrete rewards */
  distribution: z.array(z.object({ value: z.number(), count: z.number() })),
})
export type RewardDimensionStats = z.infer<typeof RewardDimensionStats>

export const QHistogramBin = z.object({
  /** Lower bound label, e.g. "-0.4" */
  bin: z.string(),
  /** Count of experiences in this bin */
  count: z.number(),
})
export type QHistogramBin = z.infer<typeof QHistogramBin>

export const QTrendPoint = z.object({
  /** ISO week or month label, e.g. "2026-W16" */
  period: z.string(),
  /** Median composite Q in this period */
  medianQ: z.number(),
  /** Number of evaluated experiences in this period */
  count: z.number(),
})
export type QTrendPoint = z.infer<typeof QTrendPoint>

export const QValueDistribution = z.object({
  /** Histogram bins for composite Q (20 bins from -1 to 1) */
  histogram: z.array(QHistogramBin),
  /** Q-value trend over time (weekly aggregation) */
  trend: z.array(QTrendPoint),
  /** Average composite Q across all evaluated experiences */
  avgCompositeQ: z.number(),
  /** Median composite Q */
  medianCompositeQ: z.number(),
  /** Standard deviation of composite Q */
  stdCompositeQ: z.number(),
})
export type QValueDistribution = z.infer<typeof QValueDistribution>

export const ExperienceRLStats = z.object({
  /** Per-dimension reward box-plot stats */
  rewardDimensions: z.array(RewardDimensionStats),
  /** Composite Q-value distribution */
  qDistribution: QValueDistribution,
  /** Average q_visits across all experiences */
  avgVisits: z.number(),
  /** Median q_visits */
  medianVisits: z.number(),
  /** Experiences never retrieved (q_visits == 0) */
  neverRetrieved: z.number(),
  /** Experiences retrieved 5+ times */
  frequentlyRetrieved: z.number(),
})
export type ExperienceRLStats = z.infer<typeof ExperienceRLStats>

// ---------------------------------------------------------------------------
// Dimension 4 — Retrieval Activity
// ---------------------------------------------------------------------------

export const TopExperienceItem = z.object({
  id: z.string(),
  intent: z.string(),
  scopeID: z.string(),
  visits: z.number(),
  compositeQ: z.number(),
})
export type TopExperienceItem = z.infer<typeof TopExperienceItem>

export const RetrievalStats = z.object({
  /** Top 10 most-retrieved experiences */
  topExperiences: z.array(TopExperienceItem),
  /** Distribution of q_visits as bar-chart-friendly data */
  visitsDistribution: z.array(
    z.object({
      range: z.string(),
      count: z.number(),
    }),
  ),
})
export type RetrievalStats = z.infer<typeof RetrievalStats>

// ---------------------------------------------------------------------------
// Dimension 5 — Scope Distribution
// ---------------------------------------------------------------------------

export const ScopeCount = z.object({
  scopeID: z.string(),
  memories: z.number(),
  experiences: z.number(),
  evaluated: z.number(),
})
export type ScopeCount = z.infer<typeof ScopeCount>

export const ScopeStats = z.object({
  scopes: z.array(ScopeCount),
})
export type ScopeStats = z.infer<typeof ScopeStats>

// ---------------------------------------------------------------------------
// Dimension 6 — Time Series
// ---------------------------------------------------------------------------

export const EngramDailyBucket = z.object({
  day: z.string(),
  memoriesCreated: z.number(),
  experiencesCreated: z.number(),
  experiencesEvaluated: z.number(),
  avgCompositeQ: z.number(),
})
export type EngramDailyBucket = z.infer<typeof EngramDailyBucket>

export const EngramTimeSeriesStats = z.object({
  days: z.array(EngramDailyBucket),
  /** Hour-of-day activity: 24-element array, each = experience count */
  hourlyActivity: z.array(z.number()),
})
export type EngramTimeSeriesStats = z.infer<typeof EngramTimeSeriesStats>

// ---------------------------------------------------------------------------
// Composite — Full Engram Stats Snapshot
// ---------------------------------------------------------------------------

export const EngramStatsSnapshot = z.object({
  overview: EngramOverviewStats,
  memoryDistribution: MemoryDistributionStats,
  experienceRL: ExperienceRLStats,
  retrieval: RetrievalStats,
  scopes: ScopeStats,
  timeSeries: EngramTimeSeriesStats,
  computedAt: z.number(),
})
export type EngramStatsSnapshot = z.infer<typeof EngramStatsSnapshot>
