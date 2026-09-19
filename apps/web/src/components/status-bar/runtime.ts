import type { I18n } from "@lingui/core"
import type { SessionRecoveringReason, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { statusBar as copy } from "@/locales/messages"
import { classifySessionActivity } from "@/utils/session-status"

type RecoveringStatus = Extract<SessionStatus, { type: "recovering" }>

function recoveringReasonLabel(reason: SessionRecoveringReason, i18n: I18n): string {
  switch (reason) {
    case "workflow":
      return i18n._(copy.recoveringWorkflow)
    case "incomplete-turn":
      return i18n._(copy.recoveringIncompleteTurn)
    case "pending-reply":
      return i18n._(copy.recoveringPendingReply)
  }
}

/** The precise cause wins; the localized cause is the fallback, and only an
 *  entirely unexplained status falls back to the legacy generic copy. */
function recoveringDetail(status: RecoveringStatus, i18n: I18n): string | undefined {
  if (status.description) return status.description
  return status.reason ? recoveringReasonLabel(status.reason, i18n) : undefined
}

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
      const detail = status?.type === "recovering" ? recoveringDetail(status, i18n) : undefined
      return detail || i18n._(copy.runtimeRecovering)
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
      const detail = status?.type === "recovering" ? recoveringDetail(status, i18n) : undefined
      const message = detail || i18n._(copy.recoveringTooltip)
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
