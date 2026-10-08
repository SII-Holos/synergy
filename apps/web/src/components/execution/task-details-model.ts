import type { ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"

export type TaskDetailsTask = ExecutionSummary["tasks"][number]
export type TaskDetailsStatus = TaskDetailsTask["status"] | "queued"

export function compactTaskStatus(task: TaskDetailsTask): TaskDetailsStatus {
  const status = task.cortex?.status
  return status === "error" ? "failed" : (status ?? task.status)
}

export function compactTasks(tasks: TaskDetailsTask[]) {
  return tasks.filter((task) => task.cortex || !["chronicler", "tool:look_at"].includes(task.interaction?.source ?? ""))
}

export function cancellableTask(task: TaskDetailsTask) {
  return task.cortex?.status === "queued" || task.cortex?.status === "running"
}

export function compactTokenText(metric: TaskDetailsTask["tokens"], calls: number, locale: string) {
  if (!metric.known && (!calls || metric.total == null)) return
  const value = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(metric.known)
  return (metric.unknown ? "≥ " : "") + value
}

export function tokenMetricText(metric: TaskDetailsTask["tokens"], locale: string) {
  if (!metric.known && metric.total == null) return "—"
  const value = new Intl.NumberFormat(locale).format(metric.known)
  return (metric.unknown ? "≥ " : "") + value
}
