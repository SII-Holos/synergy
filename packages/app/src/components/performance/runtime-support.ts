import type { PerformanceSummary } from "./types"

export type RuntimeSupportItem = { label: string; value: string; tone: "default" | "warning" | "success" }

export function runtimeSupportItems(summary: PerformanceSummary | null | undefined): RuntimeSupportItem[] {
  const runtime = summary?.runtime
  if (!runtime) {
    return [
      { label: "Runtime lock", value: "Unknown", tone: "warning" },
      { label: "Trace files", value: "0 files", tone: "default" },
      { label: "Recent errors", value: "0", tone: "default" },
      { label: "Pending sessions", value: "0", tone: "default" },
    ]
  }
  const lockState = runtime.alive === undefined ? "Unknown" : runtime.alive ? "Alive" : "Not running"
  const healthState = runtime.healthy === undefined ? "unknown" : runtime.healthy ? "healthy" : "needs attention"
  const processDetail = [lockState, runtime.pid ? `pid ${runtime.pid}` : undefined, runtime.mode]
    .filter(Boolean)
    .join(" · ")
  return [
    {
      label: "Runtime lock",
      value: `${processDetail || lockState} · ${healthState}`,
      tone: runtime.healthy === false || runtime.alive === false ? "warning" : runtime.healthy ? "success" : "default",
    },
    { label: "Trace files", value: `${runtime.traceFiles} files`, tone: "default" },
    {
      label: "Recent errors",
      value: String(runtime.recentErrors),
      tone: runtime.recentErrors > 0 ? "warning" : "default",
    },
    {
      label: "Pending sessions",
      value: String(runtime.pendingSessions),
      tone: runtime.pendingSessions > 0 ? "warning" : "default",
    },
  ]
}
