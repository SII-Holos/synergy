import type {
  Session,
  SessionWorkspace,
  SessionWorkspaceSelection,
  WorkspaceInfo,
} from "@ericsanchezok/synergy-sdk/client"

export function workspaceLocation(input: {
  session?: Pick<Session, "workspace" | "workspaceID">
  selection?: SessionWorkspaceSelection
  current?: SessionWorkspace | null
  records?: WorkspaceInfo[]
}): {
  state: "none" | "unavailable" | "bound" | "planned"
  path?: string
  isolated?: boolean
  stored?: boolean
  name?: string
} {
  const location = (record: WorkspaceInfo) =>
    record.backend?.provider === "objects"
      ? {
          state: "bound" as const,
          stored: true,
          name: typeof record.metadata.name === "string" ? record.metadata.name : record.id,
        }
      : { state: "bound" as const, path: record.binding.path!, isolated: record.type === "git_worktree" }
  if (!input.session) {
    const selection = input.selection
    if (selection?.mode === "none") return { state: "none" }
    if (selection?.mode === "create") return { state: "planned", isolated: true }
    if (selection?.mode === "existing") return { state: "planned", isolated: true, path: selection.target }
    if (selection?.mode === "workspace") {
      const record = input.records?.find((item) => item.id === selection.workspaceID)
      if (
        !record ||
        record.lifecycle !== "active" ||
        record.binding.state !== "bound" ||
        record.binding.generation !== selection.workspaceGeneration ||
        (!record.binding.path && record.backend?.provider !== "objects")
      )
        return { state: "unavailable" }
      return location(record)
    }
  }
  const workspace = input.session ? input.session.workspace : input.current
  if (!workspace) {
    const record = input.records?.find((item) => item.id === input.session?.workspaceID)
    if (record?.backend?.provider === "objects" && record.lifecycle === "active" && record.binding.state === "bound")
      return location(record)
    return { state: input.session?.workspaceID ? "unavailable" : "none" }
  }
  if (workspace.bindingState === "unbound" || (workspace.lifecycle && workspace.lifecycle !== "active"))
    return { state: "unavailable" }
  return { state: "bound", path: workspace.path, isolated: workspace.type === "git_worktree" }
}
