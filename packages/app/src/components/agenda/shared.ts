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
    return "bg-icon-success-base/12 text-icon-success-base ring-1 ring-inset ring-icon-success-base/15"
  if (status === "paused")
    return "bg-icon-warning-base/14 text-icon-warning-base ring-1 ring-inset ring-icon-warning-base/15"
  if (status === "pending") {
    return "bg-surface-interactive-selected-weak text-text-interactive-base ring-1 ring-inset ring-border-interactive-base/15"
  }
  if (status === "done") return "bg-surface-inset-base/85 text-text-weak ring-1 ring-inset ring-border-base/40"
  if (status === "cancelled") {
    return "bg-text-diff-delete-base/12 text-text-diff-delete-base ring-1 ring-inset ring-text-diff-delete-base/12"
  }
  return "bg-surface-inset-base/85 text-text-weak ring-1 ring-inset ring-border-base/40"
}

export function agendaRunStatusTone(status: string) {
  if (status === "ok") return "text-icon-success-base"
  if (status === "error") return "text-text-diff-delete-base"
  return "text-text-weaker"
}

export function agendaRunDotTone(status: string) {
  if (status === "ok") return "bg-icon-success-base"
  if (status === "error") return "bg-text-diff-delete-base"
  return "bg-text-weaker/40"
}
