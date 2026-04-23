import z from "zod"

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const TokenBreakdown = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.object({
    read: z.number(),
    write: z.number(),
  }),
})
export type TokenBreakdown = z.infer<typeof TokenBreakdown>

/** YYYY-MM-DD string */
export type DayKey = string

/** ISO week string like "2026-W17" */
export type WeekKey = string

/** YYYY-MM string */
export type MonthKey = string

// ---------------------------------------------------------------------------
// Dimension 1 — Overview
// ---------------------------------------------------------------------------

export const OverviewStats = z.object({
  totalSessions: z.number(),
  activeSessions: z.number(),
  archivedSessions: z.number(),
  totalMessages: z.number(),
  totalTurns: z.number(),
  totalDays: z.number(),
  longestStreak: z.number(),
  currentStreak: z.number(),
  projectCount: z.number(),
})
export type OverviewStats = z.infer<typeof OverviewStats>

// ---------------------------------------------------------------------------
// Dimension 2 — Tokens & Cost
// ---------------------------------------------------------------------------

export const TokenCostStats = z.object({
  tokens: TokenBreakdown,
  cost: z.number(),
  cacheHitRate: z.number(),
  avgCostPerTurn: z.number(),
  avgTokensPerTurn: z.number(),
  dailyCost: z.number(),
  dailyTokens: z.number(),
})
export type TokenCostStats = z.infer<typeof TokenCostStats>

// ---------------------------------------------------------------------------
// Dimension 3 — By Model  (providerID/modelID → usage)
// ---------------------------------------------------------------------------

export const ModelUsage = z.object({
  providerID: z.string(),
  modelID: z.string(),
  messages: z.number(),
  turns: z.number(),
  tokens: TokenBreakdown,
  cost: z.number(),
  avgResponseMs: z.number(),
})
export type ModelUsage = z.infer<typeof ModelUsage>

export const ModelStats = z.object({
  models: z.array(ModelUsage),
})
export type ModelStats = z.infer<typeof ModelStats>

// ---------------------------------------------------------------------------
// Dimension 4 — By Agent
// ---------------------------------------------------------------------------

export const AgentUsage = z.object({
  agent: z.string(),
  messages: z.number(),
  sessions: z.number(),
  tokens: TokenBreakdown,
  cost: z.number(),
  subagentInvocations: z.number(),
})
export type AgentUsage = z.infer<typeof AgentUsage>

export const AgentStats = z.object({
  agents: z.array(AgentUsage),
  totalSubagentCalls: z.number(),
})
export type AgentStats = z.infer<typeof AgentStats>

// ---------------------------------------------------------------------------
// Dimension 5 — By Tool
// ---------------------------------------------------------------------------

export const ToolUsage = z.object({
  tool: z.string(),
  calls: z.number(),
  successes: z.number(),
  errors: z.number(),
  avgDurationMs: z.number(),
})
export type ToolUsage = z.infer<typeof ToolUsage>

export const ToolStats = z.object({
  tools: z.array(ToolUsage),
})
export type ToolStats = z.infer<typeof ToolStats>

// ---------------------------------------------------------------------------
// Dimension 6 — Code Changes
// ---------------------------------------------------------------------------

export const CodeChangeStats = z.object({
  totalAdditions: z.number(),
  totalDeletions: z.number(),
  totalFiles: z.number(),
  netLines: z.number(),
  dailyAdditions: z.number(),
  dailyDeletions: z.number(),
})
export type CodeChangeStats = z.infer<typeof CodeChangeStats>

// ---------------------------------------------------------------------------
// Dimension 7 — Session Lifecycle
// ---------------------------------------------------------------------------

export const SessionLifecycleStats = z.object({
  pinnedCount: z.number(),
  avgTurnsPerSession: z.number(),
  medianTurnsPerSession: z.number(),
  compactionCount: z.number(),
  retryCount: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
  /** Bucketed session duration: short (<5min), medium (5-30min), long (>30min) */
  durationBuckets: z.object({
    short: z.number(),
    medium: z.number(),
    long: z.number(),
  }),
})
export type SessionLifecycleStats = z.infer<typeof SessionLifecycleStats>

// ---------------------------------------------------------------------------
// Dimension 8 — By Channel / Endpoint
// ---------------------------------------------------------------------------

export const ChannelUsage = z.object({
  channel: z.string(),
  sessions: z.number(),
  messages: z.number(),
})
export type ChannelUsage = z.infer<typeof ChannelUsage>

export const ChannelStats = z.object({
  channels: z.array(ChannelUsage),
  interactiveSessions: z.number(),
  unattendedSessions: z.number(),
})
export type ChannelStats = z.infer<typeof ChannelStats>

// ---------------------------------------------------------------------------
// Dimension 9 — Time Series (per-day bucket)
// ---------------------------------------------------------------------------

export const DailyBucket = z.object({
  day: z.string(),
  sessions: z.number(),
  turns: z.number(),
  tokens: TokenBreakdown,
  cost: z.number(),
  additions: z.number(),
  deletions: z.number(),
  files: z.number(),
  toolCalls: z.number(),
  errors: z.number(),
})
export type DailyBucket = z.infer<typeof DailyBucket>

export const HourlyBucket = z.object({
  hour: z.string(),
  turns: z.number(),
})
export type HourlyBucket = z.infer<typeof HourlyBucket>

export const TimeSeriesStats = z.object({
  days: z.array(DailyBucket),
  hours: z.array(HourlyBucket),
  /** Hour-of-day activity: 24-element array, each = turn count */
  hourlyActivity: z.array(z.number()),
})
export type TimeSeriesStats = z.infer<typeof TimeSeriesStats>

// ---------------------------------------------------------------------------
// Composite — Full Stats Snapshot
// ---------------------------------------------------------------------------

export const StatsSnapshot = z.object({
  overview: OverviewStats,
  tokenCost: TokenCostStats,
  models: ModelStats,
  agents: AgentStats,
  tools: ToolStats,
  codeChanges: CodeChangeStats,
  lifecycle: SessionLifecycleStats,
  channels: ChannelStats,
  timeSeries: TimeSeriesStats,
  /** Timestamp when this snapshot was computed */
  computedAt: z.number(),
  /** Watermark: latest session.updated we scanned up to */
  watermark: z.number(),
})
export type StatsSnapshot = z.infer<typeof StatsSnapshot>

// ---------------------------------------------------------------------------
// Per-Session Digest (intermediate product for incremental aggregation)
// ---------------------------------------------------------------------------

export const SessionDigest = z.object({
  sessionID: z.string(),
  scopeID: z.string(),
  created: z.number(),
  updated: z.number(),
  archived: z.number().optional(),
  pinned: z.boolean(),
  parentID: z.string().optional(),
  endpoint: z
    .object({
      kind: z.string(),
      type: z.string().optional(),
    })
    .optional(),
  interaction: z
    .object({
      mode: z.string(),
      source: z.string().optional(),
    })
    .optional(),

  turns: z.number(),
  messages: z.number(),
  tokens: TokenBreakdown,
  cost: z.number(),

  /** model key (providerID/modelID) → { messages, tokens, cost, totalResponseMs } */
  modelUsage: z.record(
    z.string(),
    z.object({
      messages: z.number(),
      tokens: TokenBreakdown,
      cost: z.number(),
      totalResponseMs: z.number(),
    }),
  ),

  /** agent → { messages, tokens, cost } */
  agentUsage: z.record(
    z.string(),
    z.object({
      messages: z.number(),
      tokens: TokenBreakdown,
      cost: z.number(),
    }),
  ),

  /** tool → { calls, successes, errors, totalDurationMs } */
  toolUsage: z.record(
    z.string(),
    z.object({
      calls: z.number(),
      successes: z.number(),
      errors: z.number(),
      totalDurationMs: z.number(),
    }),
  ),

  /** YYYY-MM-DDTHH → turn count */
  hourlyTurns: z.record(z.string(), z.number()),

  additions: z.number(),
  deletions: z.number(),
  files: z.number(),

  compactionCount: z.number(),
  retryCount: z.number(),
  errorCount: z.number(),

  /** Duration in ms (updated - created) */
  durationMs: z.number(),
})
export type SessionDigest = z.infer<typeof SessionDigest>

// ---------------------------------------------------------------------------
// Watermark — tracks incremental scan progress
// ---------------------------------------------------------------------------

export const StatsWatermark = z.object({
  /** Last session.updated timestamp we scanned */
  lastUpdated: z.number(),
  /** Set of sessionIDs already digested (to detect deletions) */
  sessionIDs: z.array(z.string()),
  /** Timestamp of last full scan */
  lastFullScanAt: z.number(),
})
export type StatsWatermark = z.infer<typeof StatsWatermark>

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

export const ProgressEvent = z.object({
  phase: z.enum(["scan", "digest", "bucket", "snapshot"]),
  current: z.number(),
  total: z.number(),
  message: z.string().optional(),
})
export type ProgressEvent = z.infer<typeof ProgressEvent>

export type ProgressCallback = (event: ProgressEvent) => void
