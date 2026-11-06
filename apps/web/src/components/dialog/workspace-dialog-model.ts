import type { SessionWorkspaceSelection, WorkspaceInfo } from "@ericsanchezok/synergy-sdk/client"
import { getFilename } from "@ericsanchezok/synergy-util/path"

export type WorkspaceDialogTarget =
  | {
      kind: "session"
      sessionID: string
      onApplied?: (selection: SessionWorkspaceSelection) => void | Promise<void>
    }
  | {
      kind: "draft"
      selection?: SessionWorkspaceSelection
      onSelect: (selection: SessionWorkspaceSelection) => void | Promise<void>
    }

export type WorkspaceRecovery = { workspaceID: string; reason?: string; isCurrent?: () => boolean }
export type WorkspaceRecoveryRequest = WorkspaceRecovery &
  (
    | { kind: "draft"; onRecovered?: (selection: SessionWorkspaceSelection) => void | Promise<void> }
    | {
        kind: "session"
        sessionID: string
        onRecovered?: (selection: SessionWorkspaceSelection) => void | Promise<void>
      }
  )

export function workspaceLabel(item: WorkspaceInfo) {
  return typeof item.metadata.name === "string" && item.metadata.name.trim()
    ? item.metadata.name
    : item.binding.path
      ? getFilename(item.binding.path)
      : item.id
}

export function workspaceBranch(item: WorkspaceInfo) {
  return typeof item.metadata.branch === "string" ? item.metadata.branch : undefined
}

export function workspaceAvailable(item: WorkspaceInfo) {
  return (
    item.lifecycle === "active" &&
    item.binding.state === "bound" &&
    item.activeMount?.state !== "unavailable" &&
    (item.backend?.provider === "objects" || (!!item.binding.path && !!item.binding.physicalID))
  )
}

export function sortWorkspaces(
  items: WorkspaceInfo[],
  input: {
    currentID?: string | null
    mainID?: string
    recoveryID?: string
    available: (item: WorkspaceInfo) => boolean
    locale: string
  },
) {
  const collator = new Intl.Collator(input.locale, { numeric: true, sensitivity: "base" })
  const priority = (item: WorkspaceInfo) =>
    item.id === input.recoveryID
      ? 0
      : item.id === input.currentID
        ? 1
        : item.id === input.mainID
          ? 2
          : input.available(item)
            ? 3
            : 4
  return [...items].sort(
    (a, b) =>
      priority(a) - priority(b) ||
      collator.compare(workspaceLabel(a), workspaceLabel(b)) ||
      collator.compare(a.binding.path ?? "", b.binding.path ?? "") ||
      a.id.localeCompare(b.id),
  )
}

export function workspaceUnavailable(error: unknown): { workspaceID: string; reason?: string } | undefined {
  if (!error || typeof error !== "object" || !("name" in error) || error.name !== "WorkspaceUnavailable") return
  const data = "data" in error ? error.data : undefined
  if (!data || typeof data !== "object" || !("workspaceID" in data) || typeof data.workspaceID !== "string") return
  return {
    workspaceID: data.workspaceID,
    reason: "reason" in data && typeof data.reason === "string" ? data.reason : undefined,
  }
}
