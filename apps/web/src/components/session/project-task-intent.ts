import type { ProjectDirectories, SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"

export function projectTaskIntent(input: {
  directories?: ProjectDirectories
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
  return { mode: "workspace", workspaceID: main.workspaceID, workspaceGeneration: main.generation }
}
