import type { PerformanceSummary } from "./types"

export type RuntimeSupportItem = { label: string; value: string; tone: "default" | "warning" | "success" }

export function runtimeSupportItems(summary: PerformanceSummary | null | undefined): RuntimeSupportItem[] {
  const runtime = summary?.runtime
  if (!runtime) {
    return [
      { label: "Runtime lock", value: "Unknown", tone: "warning" },
      { label: "Mirror files", value: "0 files", tone: "default" },
      { label: "Recent errors", value: "0", tone: "default" },
      { label: "Pending sessions", value: "0", tone: "default" },
      { label: "Session runtimes", value: "0 total", tone: "default" },
      { label: "Cortex tasks", value: "0 retained", tone: "default" },
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
    { label: "Mirror files", value: `${runtime.mirrorFiles} files`, tone: "default" },
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
    {
      label: "Session runtimes",
      value: `${runtime.sessionRuntimes.totalCount} total · ${runtime.sessionRuntimes.runningCount} running`,
      tone: "default",
    },
    {
      label: "Cortex tasks",
      value: `${runtime.cortexTasks.totalCount} retained · ${runtime.cortexTasks.runningCount} running`,
      tone: "default",
    },
  ]
}
