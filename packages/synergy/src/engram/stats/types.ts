import z from "zod"

// ---------------------------------------------------------------------------
// Dimension 1 — Overview
// ---------------------------------------------------------------------------

export const EngramOverviewStats = z.object({
  totalMemories: z.number(),
  totalExperiences: z.number(),
  /** Memories created vs last updated (shows edit activity) */
  memoriesEdited: z.number(),
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
  /** category × recallMode matrix: { "coding:contextual": 5, ... } */
  categoryRecallMatrix: z.record(z.string(), z.number()),
})
export type MemoryDistributionStats = z.infer<typeof MemoryDistributionStats>

// ---------------------------------------------------------------------------
// Dimension 3 — Experience Reward & Q-Learning
// ---------------------------------------------------------------------------

export const RewardDimensionStats = z.object({
  dimension: z.string(),
  avg: z.number(),
  median: z.number(),
  p90: z.number(),
})
export type RewardDimensionStats = z.infer<typeof RewardDimensionStats>

export const QValueDistribution = z.object({
  /** Count of experiences in each Q-value bucket */
  negative: z.number(), // composite Q < -0.3
  low: z.number(), // -0.3 <= composite Q < 0
  neutral: z.number(), // 0 <= composite Q < 0.3
  medium: z.number(), // 0.3 <= composite Q < 0.6
  high: z.number(), // composite Q >= 0.6
  /** Average composite Q across all evaluated experiences */
  avgCompositeQ: z.number(),
  /** Median composite Q */
  medianCompositeQ: z.number(),
})
export type QValueDistribution = z.infer<typeof QValueDistribution>

export const ExperienceRLStats = z.object({
  /** Per-dimension reward averages (outcome, intent, execution, orchestration, expression) */
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
  /** Distribution of q_visits: [{ range: "0", count: 50 }, { range: "1-2", count: 30 }, ...] */
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
