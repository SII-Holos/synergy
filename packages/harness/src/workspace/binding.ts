import path from "node:path"
import { randomUUID } from "node:crypto"
import { RuntimeContext } from "../lifecycle/context"
import { WorkspaceCatalog } from "./catalog"
import { WorkspaceLocation } from "./location"
import type { Workspace } from "../session/workspace-schema"

export namespace WorkspaceBinding {
  export async function register(scopeID: string, directory: string): Promise<WorkspaceCatalog.Info> {
    if (!path.isAbsolute(directory)) throw new Error("Workspace location must be absolute")
    const source = WorkspaceLocation.source()
    const location = await source.identify(directory)
    return WorkspaceCatalog.register({ scopeID, type: "directory", hostID: await source.hostID(), ...location })
  }

  export async function importHistory(
    workspace: Workspace,
    scopeID: string,
    record?: WorkspaceCatalog.Info,
  ): Promise<Workspace> {
    if (workspace.scopeID !== scopeID || (record && record.scopeID !== scopeID))
      throw new Error("Workspace belongs to a different Scope")
    const { path: location, scopeID: _scope, type, id, generation, ...metadata } = workspace
    const imported = await WorkspaceCatalog.importRecord(
      record ?? {
        id: id ?? `wsp_${randomUUID().replaceAll("-", "")}`,
        scopeID,
        type,
        revision: 1,
        metadata,
        binding: { state: "unbound", hostID: "unknown", path: location, generation: generation ?? 1 },
        sharedWritableWorkspaceIDs: [],
        lifecycle: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    )
    return WorkspaceCatalog.projection(imported)
  }

  export async function migrate(workspace: Workspace | null, scopeID: string): Promise<Workspace | null> {
    if (!workspace) return null
    return RuntimeContext.current().host.workspaceLocation
      ? adopt(workspace, scopeID)
      : importHistory(workspace, scopeID)
  }

  export async function adopt(workspace: Workspace | null, scopeID: string): Promise<Workspace | null> {
    if (!workspace) return null
    if (workspace.scopeID !== scopeID) throw new Error("Workspace belongs to a different Scope")
    if (workspace.id?.startsWith("wsp_"))
      return WorkspaceCatalog.projection(await WorkspaceCatalog.get(workspace.id, scopeID))
    if (!path.isAbsolute(workspace.path)) throw new Error("Workspace location must be absolute")
    const source = WorkspaceLocation.source()
    const hostID = await source.hostID()
    const location = await source.identify(workspace.path, true)
    const { path: _path, scopeID: _scope, type, id: _id, generation: _generation, ...metadata } = workspace
    const info = await WorkspaceCatalog.register({ scopeID, type, hostID, ...location, metadata })
    return WorkspaceCatalog.projection(info)
  }

  export async function validate(workspaceID: string, scopeID: string, generation?: number): Promise<Workspace> {
    const source = WorkspaceLocation.source()
    const info = await WorkspaceCatalog.resolve(workspaceID, { scopeID, hostID: await source.hostID(), generation })
    const actual = await source.identify(info.binding.path).catch(() => {
      throw new WorkspaceCatalog.Unavailable({ message: "The Workspace directory is unavailable", workspaceID })
    })
    if (info.binding.physicalID && actual.physicalID !== info.binding.physicalID)
      throw new WorkspaceCatalog.Unavailable({
        message: "The Workspace directory was replaced; rebind it before executing",
        workspaceID,
      })
    return WorkspaceCatalog.projection(info)
  }
}
