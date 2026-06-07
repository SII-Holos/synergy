import { LoopJob } from "./loop-job"
import { Session } from "."
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { SearchGuard } from "@/tool/search-guard"

const log = Log.create({ service: "session.loop-signals" })

// ─── shared helpers ────────────────────────────────────────────────

type AssistantMsg = MessageV2.WithParts & { info: MessageV2.Assistant }

function recentAssistants(ctx: LoopJob.Context, n: number): AssistantMsg[] {
  return ctx.messages.filter((m): m is AssistantMsg => m.info.role === "assistant").slice(-n)
}

function lastAssistant(ctx: LoopJob.Context): AssistantMsg | undefined {
  return recentAssistants(ctx, 1).at(0)
}

async function appendSyntheticUserText(ctx: LoopJob.Context, text: string) {
  const part = (await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: ctx.lastUser.id,
    sessionID: ctx.sessionID,
    type: "text",
    text,
    synthetic: true,
    time: { start: Date.now(), end: Date.now() },
  })) as MessageV2.Part

  ctx.lastUserParts.push(part)
  const userMessage = ctx.messages.find((msg) => msg.info.id === ctx.lastUser.id)
  if (userMessage && userMessage.parts !== ctx.lastUserParts) userMessage.parts.push(part)
}

function hasSyntheticMarker(ctx: LoopJob.Context, marker: string): boolean {
  return ctx.lastUserParts.some((part) => part.type === "text" && part.synthetic && part.text.includes(marker))
}

function isScholarContext(ctx: LoopJob.Context): boolean {
  return ctx.lastUser.agent === "scholar" || recentAssistants(ctx, 8).some((msg) => msg.info.agent === "scholar")
}

function recentSearchRecords(ctx: LoopJob.Context): SearchGuard.SearchRecord[] {
  return recentAssistants(ctx, 8).flatMap((msg) =>
    msg.parts.flatMap((part) => {
      if (part.type !== "tool") return []
      const record = SearchGuard.buildRecord(part)
      return record ? [record] : []
    }),
  )
}

function dominantFailureType(failures: SearchGuard.SearchRecord[]): SearchGuard.FailureType | undefined {
  const counts = new Map<SearchGuard.FailureType, number>()
  for (const failure of failures) {
    if (!failure.failureType) continue
    counts.set(failure.failureType, (counts.get(failure.failureType) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function formatSearchFailures(failures: SearchGuard.SearchRecord[]): string {
  return failures
    .map((failure) => {
      const target = failure.query ?? failure.domain ?? "(unknown target)"
      const domain = failure.domain ? ` domain=${failure.domain}` : ""
      return `- ${failure.tool}: ${target} -> ${failure.failureType ?? "unknown"}${domain}`
    })
    .join("\n")
}

function formatDomainSummary(failures: SearchGuard.SearchRecord[]): string | undefined {
  const byDomain = new Map<string, Map<string, number>>()
  for (const failure of failures) {
    if (!failure.domain || !failure.failureType) continue
    const counts = byDomain.get(failure.domain) ?? new Map<string, number>()
    counts.set(failure.failureType, (counts.get(failure.failureType) ?? 0) + 1)
    byDomain.set(failure.domain, counts)
  }
  if (byDomain.size === 0) return undefined
  return [...byDomain.entries()]
    .map(([domain, counts]) => {
      const summary = [...counts.entries()].map(([type, count]) => `${type}:${count}`).join(", ")
      return `- ${domain}: ${summary}`
    })
    .join("\n")
}

function buildSearchAnalysis(ctx: LoopJob.Context) {
  const records = recentSearchRecords(ctx)
  const failures = SearchGuard.trailingFailures(records)
  const dominant = dominantFailureType(failures)
  return {
    records,
    failures,
    dominant,
    hasSimilarQueries: SearchGuard.hasSimilarQueries(records.slice(-6)),
  }
}

// ─── compact signal ────────────────────────────────────────────────

LoopJob.defineSignal({
  type: "compact",
  detect(ctx) {
    return ctx.lastUserParts.some((p) => p.type === "compaction")
  },
})

// ─── error loop: same tool + same error class, all failed ──────────

const ERROR_LOOP_THRESHOLD = 10

LoopJob.defineSignal({
  type: "error_loop",
  detect(ctx) {
    if (ctx.step < ERROR_LOOP_THRESHOLD) return false

    const recent = recentAssistants(ctx, ERROR_LOOP_THRESHOLD)
    if (recent.length < ERROR_LOOP_THRESHOLD) return false

    const errorSignatures: string[] = []
    for (const msg of recent) {
      const errorParts = msg.parts.filter(
        (p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "error",
      )
      if (errorParts.length === 0) return false

      const sig = errorParts
        .map((p) => {
          const errorText = p.state.status === "error" ? p.state.error : ""
          return `${p.tool}:${extractErrorName(errorText)}`
        })
        .sort()
        .join("|")
      errorSignatures.push(sig)
    }

    const allSame = errorSignatures.every((sig) => sig === errorSignatures[0])
    if (allSame) {
      log.warn("error loop detected", {
        sessionID: ctx.sessionID,
        step: ctx.step,
        signature: errorSignatures[0],
      })
    }
    return allSame
  },
})

function extractErrorName(error: string): string {
  const colonIndex = error.indexOf(":")
  if (colonIndex > 0 && colonIndex < 60) {
    const candidate = error.slice(0, colonIndex).trim()
    if (/^[A-Z]\w*Error$/.test(candidate)) return candidate
  }
  return "UnknownError"
}

LoopJob.register({
  type: "error_loop_breaker",
  phase: "pre",
  blocking: true,
  signals: ["error_loop"],
  collect() {
    return []
  },
  async execute(ctx) {
    const msg = lastAssistant(ctx)

    const errorParts = msg?.parts.filter(
      (p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "error",
    )

    const errorSummary = errorParts?.length
      ? errorParts
          .map((p) => {
            const errorText = p.state.status === "error" ? p.state.error : ""
            return `${p.tool}: ${errorText.slice(0, 200)}`
          })
          .join("; ")
      : "unknown error"

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: ctx.lastUser.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: `[Tool error loop detected] The same tool has failed ${ERROR_LOOP_THRESHOLD} times in a row with the same error class. Stopping to avoid wasting further resources. Last error: ${errorSummary}`,
      time: { start: Date.now(), end: Date.now() },
      synthetic: true,
    })

    return "stop"
  },
})

// ─── repeat loop: same tool + same params, all successful ──────────

const REPEAT_LOOP_THRESHOLD = 3

function toolCallKey(part: MessageV2.ToolPart): string {
  return `${part.tool}::${JSON.stringify(part.state.input)}`
}

LoopJob.defineSignal({
  type: "repeat_loop",
  detect(ctx) {
    const recent = recentAssistants(ctx, REPEAT_LOOP_THRESHOLD)
    if (recent.length < REPEAT_LOOP_THRESHOLD) return false

    const sigs: string[] = []
    for (const msg of recent) {
      const successfulParts = msg.parts.filter(
        (p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "completed",
      )
      if (successfulParts.length === 0) return false
      sigs.push(successfulParts.map(toolCallKey).sort().join("|"))
    }

    const allSame = sigs.every((s) => s === sigs[0])
    if (allSame) {
      log.warn("repeat loop detected", {
        sessionID: ctx.sessionID,
        step: ctx.step,
        signature: sigs[0],
      })
    }
    return allSame
  },
})

LoopJob.register({
  type: "repeat_loop_injector",
  phase: "pre",
  blocking: true,
  signals: ["repeat_loop"],
  collect() {
    return []
  },
  async execute(ctx) {
    const msg = lastAssistant(ctx)

    const toolParts = msg?.parts.filter(
      (p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "completed",
    )
    if (!toolParts?.length) return "pass"

    const toolSummary = toolParts
      .map((p) => {
        const args = JSON.stringify(p.state.input).slice(0, 120)
        return `  - ${p.tool}(${args})`
      })
      .join("\n")

    const warning = [
      `[Tool repeat loop detected] The same tool has been called successfully with the same arguments ${REPEAT_LOOP_THRESHOLD} times in a row. This may indicate an infinite loop.`,
      `Before continuing, verify that the tool is making progress. If stuck, try a different approach or report the situation to the user.`,
      `Last successful calls:`,
      toolSummary,
    ].join("\n")

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: ctx.lastUser.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: warning,
      time: { start: Date.now(), end: Date.now() },
      synthetic: true,
    })

    return "pass"
  },
})

// --- scholar search reflection: repeated search/fetch failures need strategy change ---

const SEARCH_REFLECTION_THRESHOLD = 2
const SEARCH_EARLY_STOP_THRESHOLD = 4

LoopJob.defineSignal({
  type: "search_failure_reflection",
  detect(ctx) {
    if (!isScholarContext(ctx)) return false
    if (hasSyntheticMarker(ctx, SearchGuard.REFLECTION_MARKER)) return false
    if (hasSyntheticMarker(ctx, SearchGuard.EARLY_STOP_MARKER)) return false

    const analysis = buildSearchAnalysis(ctx)
    return analysis.failures.length >= SEARCH_REFLECTION_THRESHOLD
  },
})

LoopJob.register({
  type: "search_failure_reflector",
  phase: "pre",
  blocking: true,
  signals: ["search_failure_reflection"],
  collect() {
    return []
  },
  async execute(ctx) {
    const analysis = buildSearchAnalysis(ctx)
    if (analysis.failures.length < SEARCH_REFLECTION_THRESHOLD) return "pass"

    const dominant = analysis.dominant ?? "blocked_or_unavailable"
    const domainSummary = formatDomainSummary(analysis.failures)
    const warning = [
      SearchGuard.REFLECTION_MARKER,
      `The last ${analysis.failures.length} scholar search/fetch attempts failed or produced unusable results.`,
      "",
      "Recent failed attempts:",
      formatSearchFailures(analysis.failures),
      ...(domainSummary ? ["", "Domain failure summary:", domainSummary] : []),
      "",
      `Dominant failure type: ${dominant}`,
      `Adjustment advice: ${SearchGuard.advice(dominant)}`,
      analysis.hasSimilarQueries
        ? "Repeated or very similar queries were detected. Do not repeat the same query; rewrite it or switch source."
        : "Before searching again, change the query or source based on the failure type.",
      "",
      "Reflect briefly before the next tool call: classify the failure, explain the strategy change, then either try one meaningfully different query/source or stop and report the limitation.",
    ].join("\n")

    await appendSyntheticUserText(ctx, warning)
    return "pass"
  },
})

LoopJob.defineSignal({
  type: "search_early_stop",
  detect(ctx) {
    if (!isScholarContext(ctx)) return false
    if (!hasSyntheticMarker(ctx, SearchGuard.REFLECTION_MARKER)) return false
    if (hasSyntheticMarker(ctx, SearchGuard.EARLY_STOP_MARKER)) return false

    const analysis = buildSearchAnalysis(ctx)
    return analysis.failures.length >= SEARCH_EARLY_STOP_THRESHOLD
  },
})

LoopJob.register({
  type: "search_early_stop_injector",
  phase: "pre",
  blocking: true,
  signals: ["search_early_stop"],
  collect() {
    return []
  },
  async execute(ctx) {
    const analysis = buildSearchAnalysis(ctx)
    if (analysis.failures.length < SEARCH_EARLY_STOP_THRESHOLD) return "pass"

    const dominant = analysis.dominant ?? "blocked_or_unavailable"
    const domainSummary = formatDomainSummary(analysis.failures)
    const message = [
      SearchGuard.EARLY_STOP_MARKER,
      `Scholar search has continued to fail after reflection (${analysis.failures.length} consecutive failed or unusable search/fetch attempts).`,
      "",
      "Stop calling search tools for this turn unless the user explicitly asks for more attempts.",
      "",
      "Return the best available conclusion now. Include:",
      "- the queries or URLs already tried",
      "- the main failure types observed",
      "- your current diagnosis",
      "- a concrete next step the user can take, such as using a different source, API, exact title, or manual browser access",
      "",
      "Recent failed attempts:",
      formatSearchFailures(analysis.failures),
      ...(domainSummary ? ["", "Domain failure summary:", domainSummary] : []),
      "",
      `Main failure type: ${dominant}`,
      `Likely next move: ${SearchGuard.advice(dominant)}`,
    ].join("\n")

    await appendSyntheticUserText(ctx, message)
    return "pass"
  },
})
