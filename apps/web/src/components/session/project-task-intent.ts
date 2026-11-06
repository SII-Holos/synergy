import type { ProjectDirectories, SessionWorkspaceSelection, WorkspaceInfo } from "@ericsanchezok/synergy-sdk/client"

export function projectTaskIntent(input: {
  directories?: ProjectDirectories
  workspaces?: Pick<WorkspaceInfo, "id" | "scopeID" | "binding">[]
  selected?: SessionWorkspaceSelection
  preference?: "main" | "worktree"
}): SessionWorkspaceSelection {
  const main = input.directories?.folders.find((folder) => folder.workspaceID === input.directories?.mainWorkspaceID)
  if (input.selected && input.selected.mode !== "current")
    return input.selected.mode === "create"
      ? { ...input.selected, sourceWorkspaceID: input.selected.sourceWorkspaceID ?? main?.workspaceID }
      : input.selected
  if (!main) return { mode: "none" }
  if (input.preference === "worktree" && main.git) return { mode: "create", sourceWorkspaceID: main.workspaceID }
  const current = input.workspaces?.find(
    (item) => item.id === main.workspaceID && item.scopeID === input.directories?.scopeID,
  )
  return {
    mode: "workspace",
    workspaceID: main.workspaceID,
    workspaceGeneration: Math.max(main.generation, current?.binding.generation ?? 0),
  }
}
