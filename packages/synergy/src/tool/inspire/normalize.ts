import type { InspireTypes } from "./types"

const FAMILY_RULES: Array<{ family: InspireTypes.StatusFamily["family"]; tokens: string[] }> = [
  { family: "running", tokens: ["running", "executing", "active", "serving", "training", "processing"] },
  {
    family: "waiting",
    tokens: ["queue", "queued", "queuing", "pending", "waiting", "scheduling", "creating", "starting"],
  },
  { family: "succeeded", tokens: ["success", "succeeded", "complete", "completed", "finish", "finished", "done"] },
  { family: "failed", tokens: ["fail", "failed", "error", "exception", "killed", "crash"] },
  { family: "stopped", tokens: ["stop", "stopped", "cancel", "cancelled", "canceled", "terminate", "terminated"] },
]

export namespace InspireNormalize {
  export function status(raw: string): InspireTypes.StatusFamily {
    const lower = raw.toLowerCase().trim()
    for (const rule of FAMILY_RULES) {
      if (rule.tokens.some((t) => lower.includes(t))) {
        const is_terminal = rule.family === "succeeded" || rule.family === "failed" || rule.family === "stopped"
        return { family: rule.family, is_terminal, raw }
      }
    }
    return { family: "unknown", is_terminal: false, raw }
  }

  export function formatDuration(ms: number | string | undefined): string {
    if (ms === undefined) return ""
    const total = typeof ms === "string" ? parseInt(ms, 10) : ms
    if (isNaN(total) || total <= 0) return ""
    const hours = Math.floor(total / 3_600_000)
    const minutes = Math.floor((total % 3_600_000) / 60_000)
    const seconds = Math.floor((total % 60_000) / 1_000)
    if (hours > 0) return `${hours} 小时 ${minutes} 分`
    if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
    return `${seconds} 秒`
  }

  export function formatTimestamp(ts: string | undefined): string {
    if (!ts) return ""
    const n = parseInt(ts, 10)
    if (isNaN(n)) return ts
    return new Date(n)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "")
  }

  export interface TimelineStage {
    label: string
    value: string
  }

  export interface TimelineAnalysis {
    summary: string
    stages: TimelineStage[]
    /** Milliseconds from created to resource_prepared */
    queueMs?: number
    /** Milliseconds from run to finished */
    runMs?: number
    /** Whether the job never reached run phase */
    neverStarted: boolean
  }

  export function analyzeTimeline(timeline: any): TimelineAnalysis {
    if (!timeline || typeof timeline !== "object") {
      return { summary: "", stages: [], neverStarted: false }
    }

    const created = parseTs(timeline.created)
    const prepared = parseTs(timeline.resource_prepared)
    const run = parseTs(timeline.run)
    const finished = parseTs(timeline.finished)

    const stages: TimelineStage[] = []
    let queueMs: number | undefined
    let runMs: number | undefined
    let neverStarted = false
    const parts: string[] = []

    if (created > 0) stages.push({ label: "创建", value: fmtTs(created) })
    if (prepared > 0) stages.push({ label: "资源就绪", value: fmtTs(prepared) })
    if (run > 0) stages.push({ label: "开始运行", value: fmtTs(run) })
    if (finished > 0) stages.push({ label: "结束", value: fmtTs(finished) })

    if (created > 0 && prepared > 0) {
      queueMs = prepared - created
      parts.push(`排队 ${formatDuration(queueMs)}`)
    }
    if (prepared > 0 && run > 0) {
      parts.push(`启动 ${formatDuration(run - prepared)}`)
    }
    if (run > 0 && finished > 0) {
      runMs = finished - run
      parts.push(`运行 ${formatDuration(runMs)}`)
    }
    if (created > 0 && run === 0 && (finished > 0 || prepared > 0)) {
      neverStarted = true
      parts.push("未进入运行阶段")
    }

    return {
      summary: parts.join(" → "),
      stages,
      queueMs,
      runMs,
      neverStarted,
    }
  }
}

function parseTs(v: any): number {
  if (!v) return 0
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : 0
  return isNaN(n) || n <= 0 ? 0 : n
}

function fmtTs(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
}
