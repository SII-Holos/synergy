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
}
