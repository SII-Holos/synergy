import type { McpStatus } from "@ericsanchezok/synergy-sdk/client"
import { dialog } from "@/locales/messages"

export type McpStatusTone = "success" | "progress" | "warning" | "danger" | "neutral"

export type McpStatusCopy = {
  label: string
  description: string
  tone: McpStatusTone
}

/** Translate function shape the helpers use; callers pass their own `_` from useLingui. */
export type McpStatusTranslate = (id: string, values?: Record<string, unknown>) => string

export function mcpStatusCopy(status: McpStatus | undefined, _: McpStatusTranslate): McpStatusCopy {
  switch (status?.status) {
    case "connected":
      return {
        label: _(dialog.mcpStatusConnected.id),
        description: _(dialog.mcpStatusConnectedDesc.id),
        tone: "success",
      }
    case "starting":
      return {
        label: _(dialog.mcpStatusStarting.id),
        description: _(dialog.mcpStatusStartingDesc.id),
        tone: "progress",
      }
    case "connecting":
      return {
        label: _(dialog.mcpStatusConnecting.id),
        description: _(dialog.mcpStatusConnectingDesc.id),
        tone: "progress",
      }
    case "listing_tools":
      return {
        label: _(dialog.mcpStatusLoadingTools.id),
        description: _(dialog.mcpStatusLoadingToolsDesc.id),
        tone: "progress",
      }
    case "reconnecting":
      return {
        label: _(dialog.mcpStatusReconnecting.id),
        description: _(dialog.mcpStatusReconnectingDesc.id, {
          attempt: status.attempt,
          maxAttempts: status.maxAttempts,
        }),
        tone: "progress",
      }
    case "failed":
      return { label: _(dialog.mcpStatusFailed.id), description: _(dialog.mcpStatusFailedDesc.id), tone: "danger" }
    case "needs_auth":
      return {
        label: _(dialog.mcpStatusNeedsAuth.id),
        description: _(dialog.mcpStatusNeedsAuthDesc.id),
        tone: "warning",
      }
    case "needs_client_registration":
      return {
        label: _(dialog.mcpStatusRegistration.id),
        description: _(dialog.mcpStatusRegistrationDesc.id),
        tone: "warning",
      }
    case "stopping":
      return {
        label: _(dialog.mcpStatusStopping.id),
        description: _(dialog.mcpStatusStoppingDesc.id),
        tone: "progress",
      }
    case "disabled":
      return { label: _(dialog.mcpStatusDisabled.id), description: _(dialog.mcpStatusDisabledDesc.id), tone: "neutral" }
    case "uninitialized":
    default:
      return { label: _(dialog.mcpStatusReady.id), description: _(dialog.mcpStatusReadyDesc.id), tone: "neutral" }
  }
}

export function mcpStatusError(status: McpStatus | undefined): string | undefined {
  if (status?.status === "failed") return status.error
  if (status?.status === "needs_client_registration") return status.error
  return undefined
}
