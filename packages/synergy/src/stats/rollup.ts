import type {
  AgentStats,
  AgentUsage,
  ChannelStats,
  ChannelUsage,
  CodeChangeStats,
  DailyBucket,
  HourlyBucket,
  ModelStats,
  ModelUsage,
  OverviewStats,
  SessionDigest,
  SessionLifecycleStats,
  StatsSnapshot,
  TimeSeriesStats,
  TokenBreakdown,
  TokenCostStats,
  ToolStats,
  ToolUsage,
} from "./types"

export namespace Rollup {
  // -----------------------------------------------------------------------
  // Token helpers
  // -----------------------------------------------------------------------

  const ZERO_TOKENS: TokenBreakdown = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }

  function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
    return {
      input: a.input + b.input,
      output: a.output + b.output,
      reasoning: a.reasoning + b.reasoning,
      cache: {
        read: a.cache.read + b.cache.read,
        write: a.cache.write + b.cache.write,
      },
    }
  }

  function totalTokens(t: TokenBreakdown): number {
    return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  }

  function dayKey(timestamp: number): string {
    const d = new Date(timestamp)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }

  function hourOfDay(timestamp: number): number {
    return new Date(timestamp).getHours()
  }

  // -----------------------------------------------------------------------
  // Dimension 1 — Overview
  // -----------------------------------------------------------------------

  function computeOverview(digests: SessionDigest[]): OverviewStats {
    const archived = digests.filter((d) => d.archived !== undefined)
    const daySet = new Set<string>()
    for (const d of digests) daySet.add(dayKey(d.created))
    const scopeSet = new Set<string>()
    for (const d of digests) scopeSet.add(d.scopeID)

    let longestStreak = 0
    let currentStreak = 0
    if (daySet.size > 0) {
      const sortedDays = [...daySet].sort()
      let prev = 0
      for (const day of sortedDays) {
        const ts = new Date(day).getTime()
        if (prev > 0 && ts - prev <= 86_400_000) {
          currentStreak++
        } else {
          currentStreak = 1
        }
        longestStreak = Math.max(longestStreak, currentStreak)
        prev = ts
      }
    }

    // Check if current streak extends to today
    const today = dayKey(Date.now())
    const sortedDays = [...daySet].sort()
    if (sortedDays.length > 0 && sortedDays[sortedDays.length - 1] !== today) {
      // Current streak already ended
    }

    return {
      totalSessions: digests.length,
      activeSessions: digests.length - archived.length,
      archivedSessions: archived.length,
      totalMessages: digests.reduce((s, d) => s + d.messages, 0),
      totalTurns: digests.reduce((s, d) => s + d.turns, 0),
      totalDays: daySet.size,
      longestStreak,
      currentStreak,
      projectCount: scopeSet.size,
    }
  }

  // -----------------------------------------------------------------------
  // Dimension 2 — Tokens & Cost
  // -----------------------------------------------------------------------

  function computeTokenCost(digests: SessionDigest[]): TokenCostStats {
    const tokens = digests.reduce((acc, d) => addTokens(acc, d.tokens), { ...ZERO_TOKENS })
    const cost = digests.reduce((s, d) => s + d.cost, 0)
    const turns = digests.reduce((s, d) => s + d.turns, 0)
    const days = new Set(digests.map((d) => dayKey(d.created))).size || 1
    const cacheTotal = tokens.input + tokens.cache.read
    const total = totalTokens(tokens)

    return {
      tokens,
      cost,
      cacheHitRate: cacheTotal > 0 ? tokens.cache.read / cacheTotal : 0,
      avgCostPerTurn: turns > 0 ? cost / turns : 0,
      avgTokensPerTurn: turns > 0 ? total / turns : 0,
      dailyCost: cost / days,
      dailyTokens: total / days,
    }
  }

  // -----------------------------------------------------------------------
  // Dimension 3 — By Model
  // -----------------------------------------------------------------------

  function computeModels(digests: SessionDigest[]): ModelStats {
    const map = new Map<string, ModelUsage>()
    for (const d of digests) {
      for (const [key, usage] of Object.entries(d.modelUsage)) {
        const existing = map.get(key)
        if (existing) {
          existing.messages += usage.messages
          existing.turns += usage.messages
          existing.tokens = addTokens(existing.tokens, usage.tokens)
          existing.cost += usage.cost
          existing.avgResponseMs =
            existing.messages > 0
              ? (existing.avgResponseMs * (existing.messages - 1) +
                  usage.totalResponseMs / Math.max(1, usage.messages)) /
                existing.messages
              : 0
        } else {
          const [providerID, modelID] = key.split("/")
          map.set(key, {
            providerID: providerID ?? "",
            modelID: modelID ?? "",
            messages: usage.messages,
            turns: usage.messages,
            tokens: { ...usage.tokens, cache: { ...usage.tokens.cache } },
            cost: usage.cost,
            avgResponseMs: usage.messages > 0 ? usage.totalResponseMs / usage.messages : 0,
          })
        }
      }
    }
    const models = [...map.values()].sort((a, b) => b.messages - a.messages)
    return { models }
  }

  // -----------------------------------------------------------------------
  // Dimension 4 — By Agent
  // -----------------------------------------------------------------------

  function computeAgents(digests: SessionDigest[]): AgentStats {
    const map = new Map<string, AgentUsage>()
    const sessionAgents = new Map<string, Set<string>>()
    let totalSubagentCalls = 0

    for (const d of digests) {
      if (d.parentID) totalSubagentCalls++

      for (const [agent, usage] of Object.entries(d.agentUsage)) {
        const existing = map.get(agent)
        if (existing) {
          existing.messages += usage.messages
          existing.tokens = addTokens(existing.tokens, usage.tokens)
          existing.cost += usage.cost
        } else {
          map.set(agent, {
            agent,
            messages: usage.messages,
            sessions: 0,
            tokens: { ...usage.tokens, cache: { ...usage.tokens.cache } },
            cost: usage.cost,
            subagentInvocations: 0,
          })
        }

        if (!sessionAgents.has(d.sessionID)) sessionAgents.set(d.sessionID, new Set())
        sessionAgents.get(d.sessionID)!.add(agent)
      }
    }

    // Count sessions per agent
    for (const agents of sessionAgents.values()) {
      for (const agent of agents) {
        const entry = map.get(agent)
        if (entry) entry.sessions++
      }
    }

    // Subagent invocations: for each session that IS a subagent (has parentID),
    // credit its agent
    for (const d of digests) {
      if (d.parentID) {
        // The agent of this subagent session
        const topAgent = Object.keys(d.agentUsage)[0]
        if (topAgent) {
          const entry = map.get(topAgent)
          if (entry) entry.subagentInvocations++
        }
      }
    }

    const agents = [...map.values()].sort((a, b) => b.messages - a.messages)
    return { agents, totalSubagentCalls }
  }

  // -----------------------------------------------------------------------
  // Dimension 5 — By Tool
  // -----------------------------------------------------------------------

  function computeTools(digests: SessionDigest[]): ToolStats {
    const map = new Map<string, ToolUsage>()
    for (const d of digests) {
      for (const [tool, usage] of Object.entries(d.toolUsage)) {
        const existing = map.get(tool)
        if (existing) {
          existing.calls += usage.calls
          existing.successes += usage.successes
          existing.errors += usage.errors
          existing.avgDurationMs =
            existing.calls > 0
              ? (existing.avgDurationMs * (existing.calls - 1) + usage.totalDurationMs / Math.max(1, usage.calls)) /
                existing.calls
              : 0
        } else {
          map.set(tool, {
            tool,
            calls: usage.calls,
            successes: usage.successes,
            errors: usage.errors,
            avgDurationMs: usage.calls > 0 ? usage.totalDurationMs / usage.calls : 0,
          })
        }
      }
    }
    const tools = [...map.values()].sort((a, b) => b.calls - a.calls)
    return { tools }
  }

  // -----------------------------------------------------------------------
  // Dimension 6 — Code Changes
  // -----------------------------------------------------------------------

  function computeCodeChanges(digests: SessionDigest[]): CodeChangeStats {
    const totalAdditions = digests.reduce((s, d) => s + d.additions, 0)
    const totalDeletions = digests.reduce((s, d) => s + d.deletions, 0)
    const days = new Set(digests.map((d) => dayKey(d.created))).size || 1

    return {
      totalAdditions,
      totalDeletions,
      totalFiles: digests.reduce((s, d) => s + d.files, 0),
      netLines: totalAdditions - totalDeletions,
      dailyAdditions: totalAdditions / days,
      dailyDeletions: totalDeletions / days,
    }
  }

  // -----------------------------------------------------------------------
  // Dimension 7 — Session Lifecycle
  // -----------------------------------------------------------------------

  function computeLifecycle(digests: SessionDigest[]): SessionLifecycleStats {
    const pinnedCount = digests.filter((d) => d.pinned).length
    const turnsPerSession = digests.map((d) => d.turns).sort((a, b) => a - b)
    const avgTurns =
      turnsPerSession.length > 0 ? turnsPerSession.reduce((s, t) => s + t, 0) / turnsPerSession.length : 0
    const mid = Math.floor(turnsPerSession.length / 2)
    const medianTurns =
      turnsPerSession.length === 0
        ? 0
        : turnsPerSession.length % 2 === 0
          ? (turnsPerSession[mid - 1] + turnsPerSession[mid]) / 2
          : turnsPerSession[mid]

    const compactionCount = digests.reduce((s, d) => s + d.compactionCount, 0)
    const retryCount = digests.reduce((s, d) => s + d.retryCount, 0)
    const errorCount = digests.reduce((s, d) => s + d.errorCount, 0)
    const totalMessages = digests.reduce((s, d) => s + d.messages, 0)

    let short = 0
    let medium = 0
    let long = 0
    for (const d of digests) {
      if (d.durationMs < 5 * 60_000) short++
      else if (d.durationMs < 30 * 60_000) medium++
      else long++
    }

    return {
      pinnedCount,
      avgTurnsPerSession: avgTurns,
      medianTurnsPerSession: medianTurns,
      compactionCount,
      retryCount,
      errorCount,
      errorRate: totalMessages > 0 ? errorCount / totalMessages : 0,
      durationBuckets: { short, medium, long },
    }
  }

  // -----------------------------------------------------------------------
  // Dimension 8 — By Channel
  // -----------------------------------------------------------------------

  function computeChannels(digests: SessionDigest[]): ChannelStats {
    const map = new Map<string, ChannelUsage>()
    let interactiveSessions = 0
    let unattendedSessions = 0

    for (const d of digests) {
      const channel = d.endpoint?.type ?? d.endpoint?.kind ?? "web"
      const existing = map.get(channel)
      if (existing) {
        existing.sessions++
        existing.messages += d.messages
      } else {
        map.set(channel, { channel, sessions: 1, messages: d.messages })
      }

      if (d.interaction?.mode === "unattended") unattendedSessions++
      else interactiveSessions++
    }

    const channels = [...map.values()].sort((a, b) => b.sessions - a.sessions)
    return { channels, interactiveSessions, unattendedSessions }
  }

  // -----------------------------------------------------------------------
  // Dimension 9 — Time Series
  // -----------------------------------------------------------------------

  function computeTimeSeries(digests: SessionDigest[]): TimeSeriesStats {
    const dayMap = new Map<string, DailyBucket>()
    const hourMap = new Map<string, number>()
    const hourlyActivity = new Array(24).fill(0) as number[]

    for (const d of digests) {
      const day = dayKey(d.created)
      const existing = dayMap.get(day)
      if (existing) {
        existing.sessions++
        existing.turns += d.turns
        existing.tokens = addTokens(existing.tokens, d.tokens)
        existing.cost += d.cost
        existing.additions += d.additions
        existing.deletions += d.deletions
        existing.files += d.files
        const totalToolCalls = Object.values(d.toolUsage).reduce((s, u) => s + u.calls, 0)
        existing.toolCalls += totalToolCalls
        existing.errors += d.errorCount
      } else {
        const totalToolCalls = Object.values(d.toolUsage).reduce((s, u) => s + u.calls, 0)
        dayMap.set(day, {
          day,
          sessions: 1,
          turns: d.turns,
          tokens: { ...d.tokens, cache: { ...d.tokens.cache } },
          cost: d.cost,
          additions: d.additions,
          deletions: d.deletions,
          files: d.files,
          toolCalls: totalToolCalls,
          errors: d.errorCount,
        })
      }

      for (const [hour, turns] of Object.entries(d.hourlyTurns)) {
        hourMap.set(hour, (hourMap.get(hour) ?? 0) + turns)
        const hourNumber = Number(hour.slice(-2))
        hourlyActivity[hourNumber] += turns
      }
    }

    const days = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day))
    const hours: HourlyBucket[] = [...hourMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, turns]) => ({ hour, turns }))
    return { days, hours, hourlyActivity }
  }

  // -----------------------------------------------------------------------
  // Full snapshot
  // -----------------------------------------------------------------------

  export function snapshot(digests: SessionDigest[], watermark: number): StatsSnapshot {
    return {
      overview: computeOverview(digests),
      tokenCost: computeTokenCost(digests),
      models: computeModels(digests),
      agents: computeAgents(digests),
      tools: computeTools(digests),
      codeChanges: computeCodeChanges(digests),
      lifecycle: computeLifecycle(digests),
      channels: computeChannels(digests),
      timeSeries: computeTimeSeries(digests),
      computedAt: Date.now(),
      watermark,
    }
  }

  // -----------------------------------------------------------------------
  // Incremental daily bucket merge
  // -----------------------------------------------------------------------

  export function mergeDailyBucket(existing: DailyBucket | undefined, incoming: DailyBucket): DailyBucket {
    if (!existing) return incoming
    return {
      day: incoming.day,
      sessions: existing.sessions + incoming.sessions,
      turns: existing.turns + incoming.turns,
      tokens: addTokens(existing.tokens, incoming.tokens),
      cost: existing.cost + incoming.cost,
      additions: existing.additions + incoming.additions,
      deletions: existing.deletions + incoming.deletions,
      files: existing.files + incoming.files,
      toolCalls: existing.toolCalls + incoming.toolCalls,
      errors: existing.errors + incoming.errors,
    }
  }

  // -----------------------------------------------------------------------
  // Sub-digest from a single session (for daily bucket)
  // -----------------------------------------------------------------------

  export function sessionToDailyBucket(d: SessionDigest): DailyBucket {
    const totalToolCalls = Object.values(d.toolUsage).reduce((s, u) => s + u.calls, 0)
    return {
      day: dayKey(d.created),
      sessions: 1,
      turns: d.turns,
      tokens: { ...d.tokens, cache: { ...d.tokens.cache } },
      cost: d.cost,
      additions: d.additions,
      deletions: d.deletions,
      files: d.files,
      toolCalls: totalToolCalls,
      errors: d.errorCount,
    }
  }
}
