import type { Session, WorkspaceInfo } from "@ericsanchezok/synergy-sdk"

export type FileWorkspace = NonNullable<Session["workspace"]> & { id: string; generation: number }

export function selectedFileWorkspace(
  session: Pick<Session, "workspace" | "workspaceID"> | undefined,
  records: WorkspaceInfo[],
) {
  if (!session) return
  if (session.workspace) return fileWorkspace(session.workspace)
  const record = records.find((item) => item.id === session.workspaceID)
  if (record?.backend?.provider !== "objects") return
  return fileWorkspace({
    id: record.id,
    generation: record.binding.generation,
    scopeID: record.scopeID,
    type: record.type,
    path: "",
    name: typeof record.metadata.name === "string" ? record.metadata.name : record.id,
    bindingState: record.binding.state,
    lifecycle: record.lifecycle,
  })
}

export function fileWorkspaceLabel(workspace: FileWorkspace) {
  return workspace.path || (typeof workspace.name === "string" ? workspace.name : workspace.id)
}

export function fileWorkspace(value: unknown): FileWorkspace | undefined {
  if (!value || typeof value !== "object") return
  const ws = value as Partial<FileWorkspace>
  if (
    typeof ws.id !== "string" ||
    !ws.id.startsWith("wsp_") ||
    typeof ws.generation !== "number" ||
    !Number.isSafeInteger(ws.generation) ||
    ws.generation < 1 ||
    typeof ws.scopeID !== "string" ||
    typeof ws.path !== "string" ||
    typeof ws.type !== "string" ||
    (ws.bindingState !== undefined && ws.bindingState !== "bound") ||
    (ws.lifecycle !== undefined && ws.lifecycle !== "active")
  )
    return
  return ws as FileWorkspace
}

export function workspaceFileResource(workspace: FileWorkspace, path: string) {
  return `${workspace.id}@${workspace.generation}/${path}`
}

export function workspaceFilePath(resource: string | undefined) {
  return resource?.replace(/^wsp_[^/@]+@\d+\//, "") ?? ""
}

export function workspaceFileOwner(tab: { state?: unknown; resourceId?: string }): FileWorkspace | undefined {
  if (!tab.state || typeof tab.state !== "object" || !("workspace" in tab.state)) return
  const ws = fileWorkspace(tab.state.workspace)
  if (!ws || (tab.resourceId && !tab.resourceId.startsWith(`${ws.id}@${ws.generation}/`))) return
  return ws
}

export function fileWorkspaceKey(server: string, scopeID: string, workspace: FileWorkspace | null) {
  return JSON.stringify([server, scopeID, workspace?.id ?? null, workspace?.generation ?? null])
}

export function catalogFileWorkspace(record: WorkspaceInfo): FileWorkspace | undefined {
  if (!record.binding.path && record.backend?.provider !== "objects") return
  return fileWorkspace({
    ...record.metadata,
    id: record.id,
    generation: record.binding.generation,
    scopeID: record.scopeID,
    type: record.type,
    path: record.binding.path ?? "",
    bindingState: record.binding.state,
    lifecycle: record.lifecycle,
  })
}

export function projectFileWorkspaces(primary: FileWorkspace | undefined, records: WorkspaceInfo[]): FileWorkspace[] {
  if (!primary) return []
  const record = records.find((item) => item.id === primary.id)
  const shared = new Set(record?.sharedWritableWorkspaceIDs ?? [])
  return [
    primary,
    ...records
      .filter((item) => item.scopeID === primary.scopeID && item.id !== primary.id && shared.has(item.id))
      .flatMap((item) => {
        const workspace = catalogFileWorkspace(item)
        return workspace ? [workspace] : []
      }),
  ]
}
