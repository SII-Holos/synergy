/** Runtime Lingui descriptors for stats host labels, UI text, and tooltips.
 *  Translate at use time via `useLocale().i18n._(descriptor)`. */

export const S = {
  // ── token-ring.tsx ──────────────────────────────────────────────────
  tokenInput: { id: "app.stats.token.label.input", message: "Input" },
  tokenOutput: { id: "app.stats.token.label.output", message: "Output" },
  tokenReasoning: { id: "app.stats.token.label.reasoning", message: "Reasoning" },
  tokenCacheRead: { id: "app.stats.token.label.cacheRead", message: "Cache read" },
  tokenCacheReadNote: { id: "app.stats.token.note.cacheRead", message: "Prompt tokens reused from cache" },
  tokenCacheWrite: { id: "app.stats.token.label.cacheWrite", message: "Cache write" },
  tokenCacheWriteNote: { id: "app.stats.token.note.cacheWrite", message: "Prompt tokens stored for reuse" },
  tokenShareTotal: { id: "app.stats.token.share.total", message: "{pct} of total" },
  tokenShareSubOne: { id: "app.stats.token.share.subOne", message: "<1% of total" },
  tokenCacheEfficiency: { id: "app.stats.token.label.cacheEfficiency", message: "Cache efficiency" },
  tokenCacheEfficiencyNote: {
    id: "app.stats.token.note.cacheEfficiency",
    message: "of prompt tokens reused from cache",
  },

  // ── stats-section.tsx ───────────────────────────────────────────────
  phaseScanning: { id: "app.stats.phase.scanning", message: "Scanning sessions" },
  phaseDigesting: { id: "app.stats.phase.digesting", message: "Digesting activity" },
  phaseBucketing: { id: "app.stats.phase.bucketing", message: "Updating buckets" },
  phaseSnapshot: { id: "app.stats.phase.snapshot", message: "Computing snapshot" },
  syncStarting: { id: "app.stats.sync.starting", message: "Starting stats sync…" },
  syncDone: { id: "app.stats.sync.done", message: "Stats synced" },
  syncFailed: { id: "app.stats.sync.failed", message: "Stats sync failed." },
  syncDropped: { id: "app.stats.sync.dropped", message: "Stats sync connection dropped." },
  loadUnavailable: { id: "app.stats.load.unavailable", message: "Usage stats are unavailable right now" },
  loadFetchError: { id: "app.stats.load.fetchError", message: "Unable to load usage stats right now." },
  loadLoading: { id: "app.stats.load.loading", message: "Loading usage stats…" },
  loadButtonLoading: { id: "app.stats.load.buttonLoading", message: "Loading…" },
  loadButtonRetry: { id: "app.stats.load.buttonRetry", message: "Retry loading stats" },

  // ── stats-section.tsx — rank list titles / descriptions ─────────────
  rankTitleModels: { id: "app.stats.rank.title.models", message: "Models" },
  rankDescModels: {
    id: "app.stats.rank.desc.models",
    message: "Compare which models you rely on most by calls, token volume, or spend.",
  },
  rankTitleAgents: { id: "app.stats.rank.title.agents", message: "Agents" },
  rankDescAgents: {
    id: "app.stats.rank.desc.agents",
    message: "See which agents carry the workload, cover the most sessions, or spend the most budget.",
  },
  rankTitleTools: { id: "app.stats.rank.title.tools", message: "Tools" },
  rankDescTools: {
    id: "app.stats.rank.desc.tools",
    message: "Switch between usage, latency, and reliability to understand your working rhythm.",
  },

  // ── overview-cards.tsx ──────────────────────────────────────────────
  overviewDayLabel: { id: "app.stats.overview.dayLabel", message: "{count, plural, one {# day} other {# days}}" },
  overviewStreakCurrent: { id: "app.stats.overview.streak.current", message: "Current streak ·" },
  overviewStreakBest: { id: "app.stats.overview.streak.best", message: "Best streak ·" },

  // ── code-summary.tsx ────────────────────────────────────────────────
  codeHeader: { id: "app.stats.code.header", message: "Code Changes" },
  codeNetGrowth: { id: "app.stats.code.label.netGrowth", message: "Net code growth" },
  codeFlow: { id: "app.stats.code.label.codeFlow", message: "Code flow" },
  codeGrowthOutpaced: { id: "app.stats.code.growth.outpaced", message: "Growth outpaced cleanup" },
  codeCleanupOutpaced: { id: "app.stats.code.growth.cleanup", message: "Cleanup outpaced new code" },
  codeBalanced: { id: "app.stats.code.growth.balanced", message: "Additions and removals stayed balanced" },
  codeNoMovement: { id: "app.stats.code.growth.noMovement", message: "No tracked code movement yet" },
  codeMovedOverall: { id: "app.stats.code.growth.movedOverall", message: "{count} lines moved overall" },
  codeAddedVsRemoved: { id: "app.stats.code.label.addedVsRemoved", message: "Added vs removed" },
  codeBreakdownSubtitle: {
    id: "app.stats.code.subtitle.breakdown",
    message: "How the overall movement breaks down",
  },
  codeSharePct: { id: "app.stats.code.share.pct", message: "{pct}% added" },
  codeRemovePct: { id: "app.stats.code.share.removePct", message: "{pct}% removed" },
  codeShareTotal: { id: "app.stats.code.share.total", message: "{pct}% of total change volume" },
  codeLinesAdded: { id: "app.stats.code.row.linesAdded", message: "Lines added" },
  codeLinesRemoved: { id: "app.stats.code.row.linesRemoved", message: "Lines removed" },
  codeFilesTouched: { id: "app.stats.code.compact.filesTouched", message: "Files touched" },
  codeFilesHint: { id: "app.stats.code.compact.filesHint", message: "Distinct files changed across tracked sessions" },
  codeAddsPerDay: { id: "app.stats.code.compact.addsPerDay", message: "Adds / day" },
  codeAddsHint: { id: "app.stats.code.compact.addsHint", message: "Average added lines per active coding day" },
  codeRemovalsPerDay: { id: "app.stats.code.compact.removalsPerDay", message: "Removals / day" },
  codeRemovalsHint: {
    id: "app.stats.code.compact.removalsHint",
    message: "Average removed lines per active coding day",
  },
  codeLinesPerFile: { id: "app.stats.code.compact.linesPerFile", message: "Lines / file" },
  codeLinesPerFileHint: {
    id: "app.stats.code.compact.linesPerFileHint",
    message: "Average touched lines per modified file",
  },

  // ── daily-trend.tsx ─────────────────────────────────────────────────
  dailyTitle: { id: "app.stats.daily.title", message: "Daily Trend" },
  dailySubtitle: { id: "app.stats.daily.subtitle", message: "Cost and token volume over time" },
  dailyCostLabel: { id: "app.stats.daily.axis.cost", message: "Cost ($)" },
  dailyTokensLabel: { id: "app.stats.daily.axis.tokens", message: "Tokens" },
  dailyTooltipCost: { id: "app.stats.daily.tooltip.cost", message: "Cost: {value}" },
  dailyTooltipTokens: { id: "app.stats.daily.tooltip.tokens", message: "Tokens: {value}" },
  dailyPeakCost: { id: "app.stats.daily.peak.cost", message: "Highest cost" },
  dailyPeakVolume: { id: "app.stats.daily.peak.volume", message: "Highest volume" },
  dailyEmpty: { id: "app.stats.daily.empty", message: "No daily activity yet" },
  dailyRange7d: { id: "app.stats.daily.range.7d", message: "7d" },
  dailyRange14d: { id: "app.stats.daily.range.14d", message: "14d" },
  dailyRange30d: { id: "app.stats.daily.range.30d", message: "30d" },
  dailyRangeAll: { id: "app.stats.daily.range.all", message: "All" },

  // ── rank-list.tsx ───────────────────────────────────────────────────
  rankLabel: { id: "app.stats.rank.label", message: "Ranking" },
  rankSortedBy: { id: "app.stats.rank.sortedBy", message: "Sorted by {metric}{unit}" },
  rankNoData: { id: "app.stats.rank.noData", message: "No ranking data yet." },
  rankShowTop: { id: "app.stats.rank.showTop", message: "Show top {n}" },
  rankShowAll: { id: "app.stats.rank.showAll", message: "Show all {n}" },
  rankMetricUnit: { id: "app.stats.rank.metric.unit", message: "metric" },
  rankMetricUSD: { id: "app.stats.rank.metric.usd", message: "USD" },
  rankMetricRate: { id: "app.stats.rank.metric.rate", message: "rate" },
  rankMetricTime: { id: "app.stats.rank.metric.time", message: "time" },
  rankAvgMs: { id: "app.stats.rank.avg.ms", message: "{value}ms avg" },
  rankAvgSec: { id: "app.stats.rank.avg.sec", message: "{value}s avg" },
  rankFallbackDesc: {
    id: "app.stats.rank.fallbackDesc",
    message: "Switch metrics to re-rank this list.",
  },

  rankMetricCalls: { id: "app.stats.rank.metric.calls", message: "Calls" },
  rankMetricTokens: { id: "app.stats.rank.metric.tokens", message: "Tokens" },
  rankMetricCost: { id: "app.stats.rank.metric.cost", message: "Cost" },
  rankMetricMessages: { id: "app.stats.rank.metric.messages", message: "Messages" },
  rankMetricSessions: { id: "app.stats.rank.metric.sessions", message: "Sessions" },
  rankMetricLatency: { id: "app.stats.rank.metric.latency", message: "Latency" },
  rankMetricSuccess: { id: "app.stats.rank.metric.success", message: "Success" },
  // ── hourly-heatmap.tsx ──────────────────────────────────────────────
  heatmapHourSubtitle: {
    id: "app.stats.heatmap.subtitle.hour",
    message: "Hourly contribution rhythm",
  },
  heatmapDaySubtitle: {
    id: "app.stats.heatmap.subtitle.day",
    message: "Daily contribution rhythm",
  },
  heatmapHourView: { id: "app.stats.heatmap.view.hour", message: "Hour view" },
  heatmapDayView: { id: "app.stats.heatmap.view.day", message: "Day view" },
  heatmapCells: { id: "app.stats.heatmap.meta.cells", message: "{n} cells" },
  heatmapRows: { id: "app.stats.heatmap.meta.rows", message: "{n, plural, one {# row} other {# rows}}" },
  heatmapQuiet: { id: "app.stats.heatmap.legend.quiet", message: "Quiet" },
  heatmapBusy: { id: "app.stats.heatmap.legend.busy", message: "Busy" },
  heatmapEmpty: { id: "app.stats.heatmap.empty", message: "No contribution activity yet" },
  heatmapTurnsSummary: {
    id: "app.stats.heatmap.turnsSummary",
    message: "{turns} turns across {active} active {unit}",
  },
  heatmapToday: { id: "app.stats.heatmap.today", message: "Today" },
  heatmapRange24h: { id: "app.stats.heatmap.range.24h", message: "24h" },
  heatmapRange7d: { id: "app.stats.heatmap.range.7d", message: "7d" },
  heatmapRange30d: { id: "app.stats.heatmap.range.30d", message: "30d" },
  heatmapRange90d: { id: "app.stats.heatmap.range.90d", message: "90d" },
  heatmapRangeAll: { id: "app.stats.heatmap.range.all", message: "All" },
  heatmapCellLabel: {
    id: "app.stats.heatmap.cellLabel",
    message: "{date} · {turns} turns",
  },
  heatmapCellLabelHour: {
    id: "app.stats.heatmap.cellLabelHour",
    message: "{date} {time} · {turns} turns",
  },

  // ── milestones.tsx ──────────────────────────────────────────────────
  milestoneTitle: { id: "app.stats.milestone.title", message: "Achievements (coming next)" },
  milestoneSubtitle: {
    id: "app.stats.milestone.subtitle",
    message: "We’ll turn your long-term stats into unlockable milestones next.",
  },

  // ── model.ts — overview label descriptors (translate at use-site) ───
  overviewLabelSessions: { id: "app.stats.overview.label.sessions", message: "Sessions" },
  overviewLabelTurns: { id: "app.stats.overview.label.turns", message: "Turns" },
  overviewLabelCost: { id: "app.stats.overview.label.cost", message: "Cost" },
  overviewLabelTokens: { id: "app.stats.overview.label.tokens", message: "Tokens" },
  overviewLabelLinesAdded: { id: "app.stats.overview.label.linesAdded", message: "Lines Added" },
  overviewLabelProjects: { id: "app.stats.overview.label.projects", message: "Projects" },
  overviewHintActive: {
    id: "app.stats.overview.hint.active",
    message: "{active} active · {archived} archived",
  },
  overviewHintMessages: { id: "app.stats.overview.hint.messages", message: "{count} total messages" },
  overviewHintCostPerDay: { id: "app.stats.overview.hint.costPerDay", message: "{cost}/day" },
  overviewHintCacheReuse: { id: "app.stats.overview.hint.cacheReuse", message: "{pct}% prompt cache reuse" },
  overviewHintNet: { id: "app.stats.overview.hint.net", message: "{count} net" },
  overviewHintActiveDays: { id: "app.stats.overview.hint.activeDays", message: "{count} active days" },

  // ── model.ts — ranking row secondary / primary descriptors ──────────
  modelAvgMs: { id: "app.stats.model.avgMs", message: "{avg}ms avg" },
  agentDelegatedRuns: { id: "app.stats.agent.delegatedRuns", message: "{count} delegated runs" },
  agentSessionsCovered: { id: "app.stats.agent.sessionsCovered", message: "{count} sessions covered" },
  toolCallsPrimary: { id: "app.stats.tool.callsPrimary", message: "{calls} calls" },
  toolAvgSecondary: { id: "app.stats.tool.avgSecondary", message: "{avg}ms avg · {pct}% success" },
  toolNoSuccessSecondary: { id: "app.stats.tool.noSuccessSecondary", message: "{avg}ms avg" },

  // ── daily-trend.tsx — chart/legend labels ───────────────────────────
  dailyCostLegend: { id: "app.stats.daily.legend.cost", message: "Cost" },
  dailyTokensLegend: { id: "app.stats.daily.legend.tokens", message: "Tokens" },

  // ── hourly-heatmap.tsx — unit labels ────────────────────────────────
  heatmapUnitHours: { id: "app.stats.heatmap.unit.hours", message: "hours" },
  heatmapUnitDays: { id: "app.stats.heatmap.unit.days", message: "days" },

  // ── rank-list.tsx — legacy metric label ─────────────────────────────
  rankLegacyValue: { id: "app.stats.rank.legacy.value", message: "Value" },

  // ── overview-cards.tsx — streak labels ──────────────────────────────
  overviewStreakCurrentLong: { id: "app.stats.overview.streak.currentLong", message: "Current streak ·" },
  overviewStreakBestLong: { id: "app.stats.overview.streak.bestLong", message: "Best streak ·" },
}
