import type { SessionWorkspace, WorkspaceInfo } from "@ericsanchezok/synergy-sdk/client"

export function projectWorkspaceBinding(
  workspace: SessionWorkspace | null,
  record: WorkspaceInfo | undefined,
  owner?: { workspaceID?: string | null; scopeID: string },
): SessionWorkspace | null {
  if (
    !record ||
    (workspace?.id ?? owner?.workspaceID) !== record.id ||
    (workspace?.scopeID ?? owner?.scopeID) !== record.scopeID ||
    (workspace?.generation ?? 0) > record.binding.generation
  )
    return workspace
  if (!record.binding.path) return null
  return {
    ...record.metadata,
    id: record.id,
    type: record.type,
    scopeID: record.scopeID,
    path: record.binding.path,
    generation: record.binding.generation,
    bindingState: record.binding.state,
    lifecycle: record.lifecycle,
  }
}
