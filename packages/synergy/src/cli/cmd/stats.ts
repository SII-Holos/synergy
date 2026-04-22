import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Engine } from "@/stats"
import type { StatsSnapshot, ProgressCallback } from "@/stats"

export const StatsCommand = cmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs: Argv) => {
    return yargs
      .option("days", {
        describe: "show stats for the last N days (default: all time)",
        type: "number",
      })
      .option("tools", {
        describe: "number of tools to show (default: all)",
        type: "number",
      })
      .option("models", {
        describe: "show model statistics (default: hidden). Pass a number to show top N, otherwise shows all",
      })
      .option("project", {
        describe: "filter by project (default: all projects, empty string: current project)",
        type: "string",
      })
      .option("recompute", {
        describe: "force full recompute from scratch",
        type: "boolean",
        default: false,
      })
      .option("json", {
        describe: "output raw JSON instead of formatted display",
        type: "boolean",
        default: false,
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const onProgress: ProgressCallback = (event) => {
        if (args.json) return
        const pct = event.total > 0 ? Math.round((event.current / event.total) * 100) : 0
        const bar = UI.progressBar({ ratio: event.current / Math.max(1, event.total), width: 30, brackets: true })
        const msg = event.message ?? event.phase
        process.stdout.write(`\r  ${bar} ${pct}% ${msg}`)
        if (event.current === event.total && event.phase === "snapshot") {
          process.stdout.write("\r\x1B[K")
        }
      }

      let snapshot: StatsSnapshot

      if (args.project !== undefined) {
        console.log("Note: project-scoped filtering requires full recomputation.")
        snapshot = await Engine.recompute(onProgress)
      } else if (args.recompute) {
        snapshot = await Engine.recompute(onProgress)
      } else {
        snapshot = await Engine.get(onProgress)
      }

      // Apply --days filter client-side on time series
      if (args.days !== undefined) {
        snapshot = filterByDays(snapshot, args.days)
      }

      if (args.json) {
        console.log(JSON.stringify(snapshot, null, 2))
        return
      }

      let modelLimit: number | undefined
      if (args.models === true) {
        modelLimit = Infinity
      } else if (typeof args.models === "number") {
        modelLimit = args.models
      }

      displayStats(snapshot, args.tools, modelLimit)
    })
  },
})

function filterByDays(snapshot: StatsSnapshot, days: number): StatsSnapshot {
  const MS_IN_DAY = 24 * 60 * 60 * 1000
  const cutoff =
    days === 0
      ? (() => {
          const d = new Date()
          d.setHours(0, 0, 0, 0)
          return d.getTime()
        })()
      : Date.now() - days * MS_IN_DAY

  const filteredDays = snapshot.timeSeries.days.filter((d) => new Date(d.day).getTime() >= cutoff)

  return {
    ...snapshot,
    timeSeries: {
      ...snapshot.timeSeries,
      days: filteredDays,
    },
  }
}

export function displayStats(snapshot: StatsSnapshot, toolLimit?: number, modelLimit?: number) {
  const width = 72

  function renderRow(label: string, value: string): string {
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - label.length - value.length
    const padding = Math.max(0, paddingNeeded)
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  function renderHeader(title: string): void {
    const innerWidth = width - 2
    const padTotal = innerWidth - title.length
    const padLeft = Math.floor(padTotal / 2)
    const padRight = padTotal - padLeft
    console.log(`│${" ".repeat(padLeft)}${title}${" ".repeat(padRight)}│`)
  }

  function topBorder(): void {
    console.log(`┌${"─".repeat(width - 2)}┐`)
  }

  function divider(): void {
    console.log(`├${"─".repeat(width - 2)}┤`)
  }

  function bottomBorder(): void {
    console.log(`└${"─".repeat(width - 2)}┘`)
  }

  const { overview, tokenCost, models, agents, tools, codeChanges, lifecycle, channels } = snapshot

  // ── Overview ──────────────────────────────────────────────
  topBorder()
  renderHeader("OVERVIEW")
  divider()
  console.log(
    renderRow(
      "Sessions",
      `${overview.totalSessions.toLocaleString()} (active: ${overview.activeSessions}, archived: ${overview.archivedSessions})`,
    ),
  )
  console.log(renderRow("Messages", overview.totalMessages.toLocaleString()))
  console.log(renderRow("Turns", overview.totalTurns.toLocaleString()))
  console.log(renderRow("Days Active", overview.totalDays.toString()))
  console.log(renderRow("Longest Streak", overview.longestStreak.toString()))
  console.log(renderRow("Current Streak", overview.currentStreak.toString()))
  console.log(renderRow("Projects", overview.projectCount.toString()))
  bottomBorder()
  console.log()

  // ── Tokens & Cost ─────────────────────────────────────────
  topBorder()
  renderHeader("TOKENS & COST")
  divider()
  console.log(renderRow("Total Cost", `$${tokenCost.cost.toFixed(2)}`))
  console.log(renderRow("Avg Cost/Turn", `$${tokenCost.avgCostPerTurn.toFixed(4)}`))
  console.log(renderRow("Daily Cost", `$${tokenCost.dailyCost.toFixed(2)}`))
  console.log(renderRow("Input Tokens", formatNumber(tokenCost.tokens.input)))
  console.log(renderRow("Output Tokens", formatNumber(tokenCost.tokens.output)))
  console.log(renderRow("Reasoning Tokens", formatNumber(tokenCost.tokens.reasoning)))
  console.log(renderRow("Cache Read", formatNumber(tokenCost.tokens.cache.read)))
  console.log(renderRow("Cache Write", formatNumber(tokenCost.tokens.cache.write)))
  console.log(renderRow("Cache Hit Rate", `${(tokenCost.cacheHitRate * 100).toFixed(1)}%`))
  console.log(renderRow("Avg Tokens/Turn", formatNumber(Math.round(tokenCost.avgTokensPerTurn))))
  console.log(renderRow("Daily Tokens", formatNumber(Math.round(tokenCost.dailyTokens))))
  bottomBorder()
  console.log()

  // ── Models ────────────────────────────────────────────────
  if (modelLimit !== undefined && models.models.length > 0) {
    const sorted = [...models.models].sort((a, b) => b.messages - a.messages)
    const toDisplay = modelLimit === Infinity ? sorted : sorted.slice(0, modelLimit)

    topBorder()
    renderHeader("MODEL USAGE")
    divider()

    for (const m of toDisplay) {
      const modelKey = `${m.providerID}/${m.modelID}`
      console.log(renderRow(modelKey, ""))
      console.log(renderRow("  Messages", m.messages.toLocaleString()))
      console.log(renderRow("  Input Tokens", formatNumber(m.tokens.input)))
      console.log(renderRow("  Output Tokens", formatNumber(m.tokens.output)))
      console.log(renderRow("  Cost", `$${m.cost.toFixed(4)}`))
      console.log(renderRow("  Avg Response", `${m.avgResponseMs.toFixed(0)}ms`))
      divider()
    }
    // Replace last divider with bottom border
    process.stdout.write("\x1B[1A")
    bottomBorder()
    console.log()
  }

  // ── Agents ────────────────────────────────────────────────
  if (agents.agents.length > 0) {
    const sorted = [...agents.agents].sort((a, b) => b.messages - a.messages)

    topBorder()
    renderHeader("AGENT USAGE")
    divider()

    for (const a of sorted) {
      console.log(renderRow(a.agent, ""))
      console.log(renderRow("  Messages", a.messages.toLocaleString()))
      console.log(renderRow("  Sessions", a.sessions.toLocaleString()))
      console.log(renderRow("  Cost", `$${a.cost.toFixed(4)}`))
      console.log(renderRow("  Subagent Calls", a.subagentInvocations.toLocaleString()))
      divider()
    }
    process.stdout.write("\x1B[1A")
    bottomBorder()
    console.log()

    if (agents.totalSubagentCalls > 0) {
      console.log(`  Total subagent calls: ${agents.totalSubagentCalls.toLocaleString()}`)
      console.log()
    }
  }

  // ── Tools ─────────────────────────────────────────────────
  if (tools.tools.length > 0) {
    const sorted = [...tools.tools].sort((a, b) => b.calls - a.calls)
    const toDisplay = toolLimit ? sorted.slice(0, toolLimit) : sorted
    const maxCalls = Math.max(...toDisplay.map((t) => t.calls))
    const totalCalls = tools.tools.reduce((sum, t) => sum + t.calls, 0)

    topBorder()
    renderHeader("TOOL USAGE")
    divider()

    for (const t of toDisplay) {
      const ratio = t.calls / maxCalls
      const bar = UI.progressBar({ ratio, width: 20, brackets: false })
      const percentage = totalCalls > 0 ? ((t.calls / totalCalls) * 100).toFixed(1) : "0.0"
      const successRate = t.calls > 0 ? ((t.successes / t.calls) * 100).toFixed(0) : "—"

      const maxToolLength = 18
      const truncatedTool = t.tool.length > maxToolLength ? t.tool.substring(0, maxToolLength - 2) + ".." : t.tool
      const toolName = truncatedTool.padEnd(maxToolLength)

      const content = ` ${toolName} ${bar.padEnd(20)} ${t.calls.toString().padStart(4)} (${percentage.padStart(4)}%) ${successRate.padStart(3)}%ok`
      const padding = Math.max(0, width - content.length - 1)
      console.log(`│${content}${" ".repeat(padding)} │`)
    }

    divider()
    const avgDurLine = ` Avg duration per tool (ms):`
    console.log(`│${avgDurLine}${" ".repeat(width - avgDurLine.length - 2)} │`)
    for (const t of toDisplay) {
      const durText = `   ${t.tool}: ${t.avgDurationMs.toFixed(0)}ms`
      const padding = Math.max(0, width - durText.length - 2)
      console.log(`│${durText}${" ".repeat(padding)} │`)
    }

    bottomBorder()
    console.log()
  }

  // ── Code Changes ──────────────────────────────────────────
  if (codeChanges.totalAdditions > 0 || codeChanges.totalDeletions > 0) {
    topBorder()
    renderHeader("CODE CHANGES")
    divider()
    console.log(renderRow("Additions", formatNumber(codeChanges.totalAdditions)))
    console.log(renderRow("Deletions", formatNumber(codeChanges.totalDeletions)))
    console.log(renderRow("Net Lines", formatNumber(codeChanges.netLines)))
    console.log(renderRow("Files Touched", formatNumber(codeChanges.totalFiles)))
    console.log(renderRow("Daily Additions", formatNumber(Math.round(codeChanges.dailyAdditions))))
    console.log(renderRow("Daily Deletions", formatNumber(Math.round(codeChanges.dailyDeletions))))
    bottomBorder()
    console.log()
  }

  // ── Lifecycle ─────────────────────────────────────────────
  topBorder()
  renderHeader("LIFECYCLE")
  divider()
  console.log(renderRow("Pinned Sessions", lifecycle.pinnedCount.toLocaleString()))
  console.log(renderRow("Avg Turns/Session", lifecycle.avgTurnsPerSession.toFixed(1)))
  console.log(renderRow("Median Turns/Session", lifecycle.medianTurnsPerSession.toFixed(1)))
  console.log(renderRow("Compactions", lifecycle.compactionCount.toLocaleString()))
  console.log(renderRow("Retries", lifecycle.retryCount.toLocaleString()))
  console.log(renderRow("Error Rate", `${(lifecycle.errorRate * 100).toFixed(1)}%`))
  console.log(
    renderRow(
      "Duration (short/med/long)",
      `${lifecycle.durationBuckets.short}/${lifecycle.durationBuckets.medium}/${lifecycle.durationBuckets.long}`,
    ),
  )
  bottomBorder()
  console.log()

  // ── Channels ──────────────────────────────────────────────
  if (channels.channels.length > 0) {
    topBorder()
    renderHeader("CHANNELS")
    divider()

    for (const c of channels.channels) {
      console.log(renderRow(c.channel, `sessions: ${c.sessions}, messages: ${c.messages}`))
    }

    divider()
    console.log(renderRow("Interactive", channels.interactiveSessions.toLocaleString()))
    console.log(renderRow("Unattended", channels.unattendedSessions.toLocaleString()))
    bottomBorder()
    console.log()
  }
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
