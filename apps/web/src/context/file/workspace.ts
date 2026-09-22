import type { Session } from "@ericsanchezok/synergy-sdk"

export type FileWorkspace = NonNullable<Session["workspace"]> & { id: string; generation: number }

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
    typeof ws.type !== "string"
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
