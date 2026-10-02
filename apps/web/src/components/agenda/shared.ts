import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
import { A, agendaWeekdays } from "./agenda-i18n"

export const agendaStatuses = {
  active: { id: "app.agenda.series.active", message: "Active" },
  paused: { id: "app.agenda.series.paused", message: "Paused" },
  pending: { id: "app.agenda.series.pending", message: "Pending" },
  done: { id: "app.agenda.series.done", message: "Done" },
  cancelled: { id: "app.agenda.series.cancelled", message: "Cancelled" },
}

export function makeTriggerSummary(
  triggers: AgendaItem["triggers"],
  _: (d: { id: string; message: string }, values?: Record<string, unknown>) => string,
): string {
  if (!triggers || triggers.length === 0) return _(A.triggerManual)
  return triggers
    .map((t) => {
      switch (t.type) {
        case "cron":
          const fields = t.expr.trim().split(/\s+/)
          const time =
            fields.length === 5 && /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1])
              ? `${fields[1].padStart(2, "0")}:${fields[0].padStart(2, "0")}`
              : undefined
          const timezone = t.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
          if (time && fields[2] === "*" && fields[3] === "*" && fields[4] === "*")
            return _({ id: "app.agenda.trigger.daily", message: "Daily at {time} ({timezone})" }, { time, timezone })
          if (time && fields[2] === "*" && fields[3] === "*" && /^[0-6]$/.test(fields[4])) {
            const weekday = _(agendaWeekdays[Number(fields[4])])
            return _(
              { id: "app.agenda.trigger.weekly", message: "Every {weekday} at {time} ({timezone})" },
              { weekday, time, timezone },
            )
          }
          return `${_(A.triggerCron, { expr: t.expr })} (${timezone})`
        case "every":
          return _(A.triggerEvery, { interval: t.interval })
        case "at":
          return _(A.triggerAt, { time: new Date(t.at).toISOString() })
        case "delay":
          return _(A.triggerDelay, { delay: String(t.delay) })
        case "watch": {
          const w = t.watch
          if ("command" in w) return _(A.triggerPoll, { command: w.command })
          if ("tool" in w) return _(A.triggerTool, { tool: w.tool })
          return _(A.triggerWatch, { glob: w.glob })
        }
        default:
          return _(A.triggerUnknown)
      }
    })
    .join(", ")
}

export function agendaRunTriggerLabel(type: string) {
  const labels: Record<string, { id: string; message: string }> = {
    manual: A.triggerManual,
    cron: { id: "app.agenda.run.trigger.cron", message: "Scheduled execution" },
    every: { id: "app.agenda.run.trigger.every", message: "Recurring execution" },
    at: { id: "app.agenda.run.trigger.at", message: "Scheduled execution" },
    delay: { id: "app.agenda.run.trigger.delay", message: "Delayed execution" },
    watch: { id: "app.agenda.run.trigger.watch", message: "Event-triggered execution" },
  }
  return labels[type] ?? A.triggerUnknown
}

export function formatAgendaDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

export function agendaStatusTone(status: string) {
  if (status === "active")
    return "bg-surface-success-weak text-text-on-success-base ring-1 ring-inset ring-border-success-base"
  if (status === "paused")
    return "bg-surface-warning-weak text-text-on-warning-base ring-1 ring-inset ring-border-warning-base"
  if (status === "pending") {
    return "bg-surface-inset-base text-text-weak ring-1 ring-inset ring-border-base/40"
  }
  if (status === "done") return "bg-surface-inset-base text-text-weak ring-1 ring-inset ring-border-base/40"
  if (status === "cancelled") {
    return "bg-text-diff-delete-base/12 text-text-diff-delete-base ring-1 ring-inset ring-text-diff-delete-base/12"
  }
  return "bg-surface-inset-base text-text-weak ring-1 ring-inset ring-border-base/40"
}

export function agendaRunStatusTone(status: string) {
  if (status === "ok") return "text-text-on-success-base"
  if (status === "error") return "text-text-diff-delete-base"
  return "text-text-weaker"
}

export function agendaRunDotTone(status: string) {
  if (status === "ok") return "bg-icon-success-base"
  if (status === "error") return "bg-text-diff-delete-base"
  return "bg-text-weaker/40"
}

export function agendaStatusLabel(status: string) {
  return (
    agendaStatuses[status as keyof typeof agendaStatuses] ?? {
      id: "app.agenda.status.unknown",
      message: "Unknown status",
    }
  )
}

export function agendaRunStatusLabel(status: string) {
  if (status === "ok") return { id: "app.agenda.runStatus.ok", message: "Succeeded" }
  if (status === "error") return { id: "app.agenda.runStatus.error", message: "Failed" }
  if (status === "skipped") return { id: "app.agenda.runStatus.skipped", message: "Skipped" }
  return { id: "app.agenda.status.unknown", message: "Unknown status" }
}
