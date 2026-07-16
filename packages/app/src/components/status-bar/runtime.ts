import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export type RuntimeTone = "base" | "danger"

export interface RuntimeIconState {
  icon: IconName
  label: string
  tooltip: string
  tone: RuntimeTone
  pulse: boolean
  copyText?: string
}

export function runtimeLabel(status: SessionStatus | undefined, waiting: boolean): string {
  if (waiting) return "waiting"
  if (!status || status.type === "idle") return "idle"
  if (status.type === "busy") return status.description || "running"
  if (status.type === "retry") return `retry ${status.attempt}`
  if (status.type === "recovering") return status.description || "recovering"
  return "idle"
}

export function resolveRuntimeIconState(status: SessionStatus | undefined, waiting: boolean): RuntimeIconState {
  const label = runtimeLabel(status, waiting)

  if (waiting) {
    return {
      icon: getSemanticIcon("session.waiting"),
      label,
      tooltip: `Runtime: ${label}`,
      tone: "danger",
      pulse: true,
    }
  }

  if (status?.type === "retry") {
    const message = status.message.trim() || `Retry attempt ${status.attempt}`
    return {
      icon: getSemanticIcon("session.retry"),
      label,
      tooltip: message,
      tone: "danger",
      pulse: true,
      copyText: message,
    }
  }

  if (status?.type === "busy") {
    return {
      icon: getSemanticIcon("session.running"),
      label,
      tooltip: `Runtime: ${label}`,
      tone: "base",
      pulse: true,
    }
  }

  if (status?.type === "recovering") {
    const message = status.description || "Session is recovering from an incomplete turn"
    return {
      icon: getSemanticIcon("session.retry"),
      label,
      tooltip: message,
      tone: "danger",
      pulse: true,
      copyText: message,
    }
  }

  return {
    icon: getSemanticIcon("session.idle"),
    label,
    tooltip: `Runtime: ${label}`,
    tone: "base",
    pulse: false,
  }
}
