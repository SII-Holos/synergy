import type { I18n } from "@lingui/core"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { statusBar as copy } from "@/locales/messages"
import { classifySessionActivity } from "@/utils/session-status"

export type RuntimeTone = "base" | "danger"

export interface RuntimeIconState {
  icon: IconName
  label: string
  tooltip: string
  tone: RuntimeTone
  pulse: boolean
  copyText?: string
}

export function runtimeLabel(status: SessionStatus | undefined, waiting: boolean, i18n: I18n): string {
  switch (classifySessionActivity({ status, waiting })) {
    case "waiting":
      return i18n._(copy.runtimeWaiting)
    case "recovering": {
      const description = status?.type === "recovering" ? status.description : undefined
      return description || i18n._(copy.runtimeRecovering)
    }
    case "working": {
      if (status?.type === "retry") return i18n._({ ...copy.retryAttempt, values: { attempt: status.attempt } })
      const description = status?.type === "busy" ? status.description : undefined
      return description || i18n._(copy.runtimeRunning)
    }
    case "idle":
      return i18n._(copy.runtimeIdle)
  }
}

export function resolveRuntimeIconState(
  status: SessionStatus | undefined,
  waiting: boolean,
  i18n: I18n,
): RuntimeIconState {
  const label = runtimeLabel(status, waiting, i18n)

  switch (classifySessionActivity({ status, waiting })) {
    case "waiting":
      return {
        icon: getSemanticIcon("session.waiting"),
        label,
        tooltip: i18n._({ ...copy.runtimeLabel, values: { label } }),
        tone: "danger",
        pulse: true,
      }
    case "recovering": {
      const description = status?.type === "recovering" ? status.description : undefined
      const message = description || i18n._(copy.recoveringTooltip)
      return {
        icon: getSemanticIcon("session.retry"),
        label,
        tooltip: message,
        tone: "danger",
        pulse: true,
        copyText: message,
      }
    }
    case "working":
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
      return {
        icon: getSemanticIcon("session.running"),
        label,
        tooltip: i18n._({ ...copy.runtimeLabel, values: { label } }),
        tone: "base",
        pulse: true,
      }
    case "idle":
      return {
        icon: getSemanticIcon("session.idle"),
        label,
        tooltip: i18n._({ ...copy.runtimeLabel, values: { label } }),
        tone: "base",
        pulse: false,
      }
  }
}
