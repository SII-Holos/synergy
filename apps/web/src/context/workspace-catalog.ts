import type { SessionWorkspace, WorkspaceInfo } from "@ericsanchezok/synergy-sdk/client"

export function projectWorkspaceBinding(
  workspace: SessionWorkspace,
  record: WorkspaceInfo | undefined,
): SessionWorkspace {
  if (
    !record ||
    workspace.id !== record.id ||
    workspace.scopeID !== record.scopeID ||
    (workspace.generation ?? 0) > record.binding.generation
  )
    return workspace
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
